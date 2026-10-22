import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Loader, LoaderContext } from 'astro/loaders'
import type { CategoryKey } from '../lib/categories'
import { classifySkill } from '../lib/classify.mjs'
import { AI_CACHE_FILE, AI_PROMPT_VERSION, SKILL_MANIFEST_FILE, loadAiCache, lookupAiCategory, lookupAiQuality } from '../lib/ai-cache.mjs'
import type { AiCacheFile } from '../lib/ai-cache.mjs'
import { deriveSkillId, skillDirectory } from '../lib/skill-id.mjs'
import { isSkillFile } from '../lib/skill-file'
import { createDedupeFilter, judgeRepoOutcome, judgeSkill, type SkillGateOptions, type SkillVerdict } from '../lib/skill-quality'
import { judgeMetadata, judgeProbe, estimateTokens, toJsonLine, type RepoMeta, type RepoProbe, type Verdict, type QualityGate } from '../lib/triage'

/* ------------------------------ 公共类型 ------------------------------ */

/** 一个 GitHub 聚合源（Agent Skills 标准格式：<目录>/SKILL.md，frontmatter 含 name/description）。 */
export interface RemoteRepo {
  /** 仓库，"owner/name" 形式 */
  repo: string
  /** 分支 / 标签 / commit；缺省用仓库默认分支（解析一次并写入缓存） */
  branch?: string
  /** 只扫描该子目录（如 "skills"）；缺省扫描整个仓库 */
  path?: string
  /** 无法从 frontmatter、目录名、路径或关键词推断分类时的兜底分类（默认 dev） */
  category?: CategoryKey
  /** 按 skill 目录名覆盖分类 */
  categoryMap?: Record<string, CategoryKey>
  /** 追加到该仓库所有 skill 的标签 */
  tags?: string[]
  /** 忽略的目录名或相对路径前缀（会与 defaultSkip 合并） */
  skip?: string[]
  /** 仓库最新推送时间（自动发现提供）；与缓存一致时跳过全部网络请求 */
  pushedAt?: string
  /** 仓库 star 数（自动发现提供，用于详情页展示热度，零额外请求） */
  stars?: number
  /** 已尝试过获取 star 数且失败；本次构建不再重试（仅影响热度展示） */
  noStarsLookup?: boolean
  /** 仓库级失败是否终止构建；显式配置默认 true，自动发现默认 false */
  strict?: boolean
  /** 单仓库 skill 数量上限（覆盖 perRepoMaxSkills） */
  maxSkills?: number
  /** 阶段 1 判定结果（自动发现时由 discoverRepos 写入）；阶段 2 继承它做增量确认 */
  triage?: Verdict
  /** 该仓库的元数据快照，写入判定日志用 */
  meta?: RepoMeta
  /** 质量门槛；阶段 2 的 README 示例检查要用 */
  quality?: QualityGate
  /** 是否跳过入库判定（显式配置的仓库默认即跳过） */
  exemptFromTriage?: boolean
}

/** 自动发现公开 skill 仓库（GitHub 检索 API，按主题 + star 排序）。 */
export interface DiscoverOptions {
  enabled: boolean
  /** 主题列表，如 ['agent-skills', 'claude-skills', 'claude-code-skills'] */
  topics: string[]
  /** 最低 star 数 */
  minStars: number
  /** 最多发现仓库数 */
  maxRepos: number
  /** 发现结果缓存时长（小时），0 表示每次构建都重新发现 */
  ttlHours: number
  /** 排除的仓库（如已显式配置的） */
  exclude?: string[]
  /**
   * 质量门槛（阶段 1 / 阶段 2）。
   * 缺省项即不启用 —— 这样 `npm run triage` 的行为与规范一致，
   * 门槛只作用于站点构建。
   */
  quality?: QualityGate
}

export interface GitHubSkillsOptions {
  repos: RemoteRepo[]
  discover?: DiscoverOptions
  /** GitHub Token；设置后 API 限额从 60 提升到 5000 次/小时 */
  token?: string
  /** GitHub API 地址（镜像 / 企业版可覆盖） */
  apiBase?: string
  /** 原始文件地址（镜像可覆盖） */
  rawBase?: string
  /** 缓存目录（绝对路径或 URL），缺省 <项目根>/.cache/skills-remote */
  cacheDir?: string | URL
  /** 全部远端 skill 的总量上限 */
  maxSkills?: number
  /** 每个仓库的 skill 上限（可被 RemoteRepo.maxSkills 覆盖） */
  perRepoMaxSkills?: number
  /** 所有仓库通用的忽略目录 */
  defaultSkip?: string[]
  /**
   * 技能级质量门槛（第三级判定）；缺省不启用。
   * 作用于「仓库已通过、单个 SKILL.md 是否上站」，见 src/lib/skill-quality.ts。
   */
  skillGate?: SkillGateOptions
  /**
   * AI 质量审查（第四级判定，记忆库驱动）：ai-classify 写入的 drop 判定
   * 在构建时硬删除对应技能。缺省开启；设 false 一键关闭（影子模式）。
   * 记忆库缺失或条目版本过旧时自动放行（宁漏勿杀）。
   */
  aiScreen?: boolean
}

/* ------------------------------ 内部类型 ------------------------------ */

interface CachedFile {
  sha: string
  frontmatter: Record<string, unknown>
  body: string
}

interface CacheFile {
  ref: string
  treeSha: string
  /** 自动发现提供的仓库推送时间（用于跳过未变更仓库） */
  pushedAt?: string
  /** 文件列表曾因单仓上限被截断（提高上限后需重新拉取文件树） */
  cappedFiles?: boolean
  fetchedAt: string
  /** 阶段 2 判定结果；仓库未变更时复用，避免每次构建重读 README */
  triage?: Verdict
  files: Record<string, CachedFile>
}

interface DiscoveryCacheFile {
  fetchedAt: string
  topics: string[]
  minStars: number
  repos: DiscoveredRepo[]
}

interface DiscoveredRepo {
  repo: string
  stars: number
  pushedAt: string
  /** 默认分支（检索结果自带）；有值时每个新仓库可省一次 API 调用 */
  branch?: string
  /**
   * 阶段 1 判定所需的其余元数据。
   *
   * 全部来自检索接口的同一条响应，**不产生任何额外请求** ——
   * 这是把判定接进构建期而不拖慢它的关键。
   */
  meta?: RepoMeta
  /** 阶段 1 判定结果；缓存下来，仓库未变更时不再重算 */
  triage?: Verdict
}

interface ResolvedOptions {
  apiBase: string
  rawBase: string
  token?: string
  cacheDir?: string | URL
  /** 技能级质量门槛；undefined = 不启用（loadRepo 用它做全部技能级判定） */
  skillGate?: SkillGateOptions
  /** AI 质量审查开关；undefined/false = 不拦截（记忆库判定被忽略） */
  aiScreen?: boolean
}

interface LoadRepoOptions extends ResolvedOptions {
  maxSkillsLeft: number
  perRepoMaxSkills: number
}

/**
 * 技能清单条目：本次构建真正收录的技能的最小信息集。
 *
 * 清单由 loader 在「所有去重与上限都生效之后」写出，因此
 * `npm run ai-classify` 读到的就是站点真实使用的技能集合，
 * 无需在脚本里复刻 id 推导、仓库顺序或截断规则。
 */
interface SkillManifestEntry {
  id: string
  /** SKILL.md 的内容 sha：记忆库据此判断内容是否变化 */
  sha: string
  /** 送进 AI 分类的描述文本 */
  description: string
  /** 来源仓库，便于排查 */
  repo: string
}

interface SkillManifestFile {
  version: number
  builtAt: string
  count: number
  /**
   * 本次构建是否发生了 GitHub 限流降级。
   *
   * 降级时站点会变小（拿不到文件树的仓库退回旧缓存），
   * 但构建仍然判成功 —— 只靠日志里那行 warn，CI 与 audit 都读不到，
   * 「部署成功」会掩盖「内容少了几千条」。写进清单后，
   * `npm run audit` 就能程序化地把它报出来。
   */
  rateLimited: boolean
  skills: SkillManifestEntry[]
}

interface LoadState {
  rateLimited: boolean
  /** 本次构建收录的技能清单（按 store 写入顺序，即最终生效顺序） */
  manifest: SkillManifestEntry[]
  /** 本次构建对每个候选仓库的判定，写入 triage.jsonl */
  triage: TriageRecord[]
  /** 本次构建被技能级门槛淘汰的技能，写入 _skill-gate.jsonl */
  skillGate: SkillGateRecord[]
  /** 跨仓去重过滤器（有状态；显式配置与高 star 仓库先处理，保首个） */
  dedupe: ReturnType<typeof createDedupeFilter>
}

/** 一条技能级判定记录，落盘为 JSON Lines 的一行 */
interface SkillGateRecord {
  repo: string
  id: string
  sha: string
  code: string
  reason: string
  /** 正文长度：审计时快速判断 SK1 的严重程度 */
  bodyChars: number
}

/** 一条判定记录，落盘为 JSON Lines 的一行 */
interface TriageRecord {
  meta: RepoMeta
  verdict: Verdict
  /** 实际抓到的文件路径；SKIP 恒为空 */
  fetchedFiles?: string[]
}

interface TreeResponse {
  sha: string
  truncated?: boolean
  /**
   * `size` 是 blob 的字节数 —— 阶段 2 的 R8（内容过薄）靠它估算 token。
   * 之前误用了「按文件个数估」，冷缓存下算出 1 个文件 = 16 token，
   * 导致每次冷重建都误杀一批仓库（实测 top50 里被 R8 砍掉 16 个）。
   */
  tree: Array<{ path: string; type: string; sha: string; size?: number }>
}

/** 一个已确认的 SKILL.md；size 来自文件树的 blob 字节数，用于阶段 2 的 token 估算 */
interface SkillFileRef {
  path: string
  sha: string
  /** 字节数；缓存路径取不到时为 0，表示「未知」 */
  size: number
}

/** 映射一个远端 skill 所需的上下文 */
interface SkillContext {
  cfg: RemoteRepo
  owner: string
  repo: string
  ref: string
  /** SKILL.md 所在目录（相对仓库根） */
  dir: string
  /** 目录最后一段（id / 显示名回退） */
  dirName: string
  /** AI 记忆库给出的分类（存在且内容未变时优先于规则层） */
  aiCategory?: CategoryKey
}

/* ------------------------------ 常量 ------------------------------ */

const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com'
const DEFAULT_CACHE_DIR = '.cache/skills-remote'
const DISCOVERY_CACHE_FILE = '_discovery.json'
/** 判定日志（JSON Lines），与语料缓存同目录 */
const TRIAGE_LOG_FILE = '_triage.jsonl'
/** 技能级门槛日志（JSON Lines），与语料缓存同目录 */
const SKILL_GATE_LOG_FILE = '_skill-gate.jsonl'
const DEFAULT_SKIP = ['template', 'templates', '.github', 'node_modules', 'dist', 'build']
const FETCH_TIMEOUT_MS = 30_000
const FILE_FETCH_CONCURRENCY = 8
/** raw 文件拉取的重试次数（CDN 偶发 429/5xx 时自动重试） */
const RAW_FETCH_RETRIES = 2
/** 重试退避基数（毫秒）：第 n 次重试等待 n × 该值 */
const RAW_RETRY_BASE_DELAY_MS = 700
const SEARCH_PER_PAGE = 100
const UNLIMITED = Number.POSITIVE_INFINITY

/**
 * 定位 AI 分类记忆库的路径。
 *
 * 记忆库是全局的（按 skill id 索引，不属于任何单个仓库的语料缓存），
 * 因此固定放在 Astro 项目根的 .cache/ 下——用 config.root 解析，
 * 不能用 import.meta.url（那会解析到 src/loaders/.cache，位置错误）。
 */
function resolveAiCachePath(root: URL | undefined): string {
  const base = root ?? new URL('../../', import.meta.url)
  return fileURLToPath(new URL(AI_CACHE_FILE, base))
}

/* ------------------------------ Loader ------------------------------ */

export function githubSkills(options: GitHubSkillsOptions): Loader {
  const resolved: ResolvedOptions = {
    apiBase: (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    rawBase: (options.rawBase ?? DEFAULT_RAW_BASE).replace(/\/+$/, ''),
    token: options.token || undefined,
    cacheDir: options.cacheDir,
    skillGate: options.skillGate,
    aiScreen: options.aiScreen,
  }
  const defaultSkip = options.defaultSkip ?? DEFAULT_SKIP

  return {
    name: 'github-skills-loader',
    async load(context) {
      const { logger } = context
      const state: LoadState = {
        rateLimited: false,
        manifest: [],
        triage: [],
        skillGate: [],
        dedupe: createDedupeFilter(),
      }

      // AI 分类记忆库（由 scripts/ai-classify.mjs 生成）。
      // 每次构建加载一次；文件不存在属正常情况（尚未跑过 AI 分类），此时全部走规则层。
      const aiCache: AiCacheFile = loadAiCache(resolveAiCachePath(context.config.root))
      const aiCached = Object.keys(aiCache.entries).length
      if (aiCached > 0) {
        // 用 warn 级别而非 info：info 在部分命令（如 astro check）下不可见，
        // 而「本次构建用了多少条 AI 分类」是排查分类异常时必须能看到的信息。
        logger.warn(
          `[github-skills] 已载入 AI 分类记忆 ${aiCached} 条（内容未变时优先采用 AI 结果；内容变更的条目仍走规则层）`,
        )
      }

      const withDefaults = (repo: RemoteRepo): RemoteRepo => ({
        ...repo,
        skip: dedupe([...(repo.skip ?? []), ...defaultSkip]),
      })

      const explicit = options.repos.map(withDefaults)

      let queue: RemoteRepo[] = explicit
      let discoveredStars: Map<string, number> | undefined
      if (options.discover?.enabled) {
        const discovered = await discoverRepos(options.discover, context, resolved)
        discoveredStars = new Map(discovered.map(item => [item.repo.toLowerCase(), item.stars]))
        /*
         * 阶段 1 硬拒绝的仓库不进队列。
         *
         * 规范里的硬拒绝（R1-R10）只作用于**自动发现**的仓库：
         * 手工配置的 4 个仓库是人工确认过的内容源，
         * 让自动规则去否决它们会造成无法预期的大规模内容消失。
         */
        const blocked = discovered.filter(item => item.triage?.decision === 'SKIP')
        const admitted = discovered.filter(item => item.triage?.decision !== 'SKIP')
        logger.info(
          `[github-skills] 阶段 1 预筛：${discovered.length} 个候选，${blocked.length} 个硬拒绝，${admitted.length} 个进入抓取`,
        )
        /*
         * 所有候选都记一条阶段 1 判定，不只是被拒的。
         *
         * 之前只在 SKIP 与走到阶段 2 时记录，结果限流降级那一次构建
         * 日志是空的 —— 而「这轮为什么没产出」恰恰是最需要日志的时候。
         * 阶段 2 会给同一个仓库补一条更精确的记录，写盘时按 repo 去重取后者。
         */
        for (const item of discovered) {
          if (!item.triage) continue
          recordTriage(state, { repo: item.repo, stars: item.stars, pushedAt: item.pushedAt, meta: item.meta }, item.triage, [])
        }
        for (const item of blocked) {
          logger.warn(`[github-skills] 跳过 ${item.repo}：${item.triage!.reason_code} ${item.triage!.reason}`)
        }
        queue = [
          ...explicit,
          ...admitted.map(item => {
            const cfg = withDefaults({
              repo: item.repo,
              branch: item.branch,
              pushedAt: item.pushedAt,
              stars: item.stars,
              strict: false,
            })
            // 把阶段 1 的判定带进 loadRepo，阶段 2 才有上下文可继承
            if (item.triage) cfg.triage = item.triage
            if (item.meta) cfg.meta = item.meta
            // 质量门槛要传到阶段 2：README 示例检查在那里
            if (options.discover?.quality) cfg.quality = options.discover.quality
            return cfg
          }),
        ]
      }

      // 去重（显式配置优先）
      const seen = new Set<string>()
      const ordered: RemoteRepo[] = []
      for (const repo of queue) {
        const key = repo.repo.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        ordered.push(repo)
      }

      /*
       * 显式配置的仓库优先入队，去重时「发现结果里的同一个仓库」会被丢掉，
       * 连带丢掉它的 stars。回填一次：stars 只影响详情页热度展示，不影响其它配置，
       * 显式指定的值仍然优先。
       */
      if (discoveredStars) {
        for (const repo of ordered) {
          if (repo.stars == null) {
            const stars = discoveredStars.get(repo.repo.toLowerCase())
            if (stars != null) repo.stars = stars
          }
        }
      }

      const totalCap = options.maxSkills ?? UNLIMITED
      const perRepoCap = options.perRepoMaxSkills ?? UNLIMITED
      let totalLoaded = 0

      for (let i = 0; i < ordered.length; i++) {
        if (totalLoaded >= totalCap) {
          logger.info(`[github-skills] 已达远端总量上限 ${totalCap}，跳过剩余 ${ordered.length - i} 个仓库`)
          break
        }
        totalLoaded += await loadRepo(
          context,
          ordered[i],
          { ...resolved, maxSkillsLeft: totalCap - totalLoaded, perRepoMaxSkills: perRepoCap },
          state,
          aiCache,
        )
      }

      if (state.rateLimited) {
        /*
         * 限流会让本次构建静默产出**更小的站点**：拿不到文件树的仓库只能
         * 退回旧缓存，上游新增的技能就消失了。这种降级必须显式报出来，
         * 否则「部署成功」会掩盖「内容少了三千条」。
         *
         * 不直接让构建失败：站点变小仍好过整站不可用，
         * 但看日志的人要能一眼发现，并知道配 GITHUB_TOKEN 就能解决。
         */
        logger.warn(
          `[github-skills] ⚠ GitHub API 限额已用尽，本次构建已降级：共收录 ${totalLoaded} 个 skill，` +
            `部分仓库只能使用旧缓存，上游新增的技能未收录。设置 GITHUB_TOKEN 可避免此降级。`,
        )
      }

      /*
       * 写出技能清单：这是「本次构建实际收录了什么」的唯一权威记录。
       * `npm run ai-classify` 读它来决定哪些条目需要 AI 判定，
       * 因此 id 去重、仓库顺序、单仓/总量截断都已在上面生效，
       * 脚本无需（也不应）复刻任何一条规则。
       */
      writeSkillManifest(state.manifest, state.rateLimited, resolved.cacheDir, context.config.root, context.logger)
      /*
       * 写出判定日志（JSON Lines）。
       *
       * 存在的意义：站点内容变多或变少时，能逐仓回答「为什么收/为什么不收」。
       * 此前 300 个发现仓库里有一半零产出，日志里只有一行 warn，
       * 事后无法区分「仓库没有 skill」与「抓取逻辑坏了」。
       */
      writeTriageLog(state.triage, resolved.cacheDir, context.config.root, context.logger)
      /*
       * 技能级门槛日志：逐条记录被淘汰的技能与原因码。
       * 与 triage.jsonl 平行 —— 仓库为什么整体不收看 triage，
       * 单个技能为什么被拒看这份；audit 会汇总它。
       */
      writeSkillGateLog(state.skillGate, state.manifest.length, resolved.cacheDir, context.config.root, context.logger)
    },
  }
}

/* ------------------------------ 自动发现 ------------------------------ */

async function discoverRepos(
  opts: DiscoverOptions,
  context: LoaderContext,
  resolved: ResolvedOptions,
): Promise<DiscoveredRepo[]> {
  const { logger, config } = context
  const cacheFile = discoveryCachePath(resolved.cacheDir, config.root)
  const cached = readDiscoveryCache(cacheFile)

  if (cached && discoveryCacheFresh(cached, opts)) {
    logger.info(`[github-skills] 自动发现缓存有效（${cached.fetchedAt}，${cached.repos.length} 个仓库）`)
    // 缓存命中也必须跑阶段 1：否则过滤只在缓存失效那一次生效，
    // 平时构建等于完全没接入判定
    return withTriage(filterDiscovered(cached.repos, opts), opts.quality)
  }

  const found: DiscoveredRepo[] = []
  try {
    for (const topic of opts.topics) {
      const query = encodeURIComponent(`topic:${topic} fork:false archived:false stars:>=${opts.minStars}`)
      const data = await ghJson<{
        items: Array<{
          full_name: string
          stargazers_count: number
          pushed_at: string
          created_at?: string
          description?: string | null
          language?: string | null
          license?: { spdx_id?: string | null } | null
          open_issues_count?: number
          topics?: string[]
          default_branch?: string
          forks_count?: number
        }>
      }>(`${resolved.apiBase}/search/repositories?q=${query}&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}`, resolved.token)
      for (const item of data.items ?? []) {
        found.push({
          repo: item.full_name,
          stars: item.stargazers_count,
          pushedAt: item.pushed_at,
          branch: item.default_branch,
          meta: {
            repo: item.full_name,
            stars: item.stargazers_count,
            description: item.description ?? '',
            language: item.language,
            // 检索查询已带 fork:false archived:false，这里仍取真实值以防查询被改
            archived: false,
            fork: false,
            license: item.license?.spdx_id ?? null,
            last_push: item.pushed_at,
            created_at: item.created_at,
            open_issues: item.open_issues_count,
            topics: item.topics ?? [],
            default_branch: item.default_branch,
            forks: item.forks_count ?? 0,
          },
        })
      }
    }
  } catch (error) {
    if (cached) {
      logger.warn(`[github-skills] 自动发现请求失败，改用缓存（${cached.fetchedAt}）— ${message(error)}`)
      return withTriage(filterDiscovered(cached.repos, opts), opts.quality)
    }
    logger.warn(`[github-skills] 自动发现请求失败且无缓存，本次跳过自动发现 — ${message(error)}`)
    return []
  }

  const merged = mergeDiscovered(found).slice(0, opts.maxRepos)
  try {
    writeDiscoveryCache(cacheFile, {
      fetchedAt: new Date().toISOString(),
      topics: opts.topics,
      minStars: opts.minStars,
      repos: merged,
    })
  } catch (error) {
    logger.warn(`[github-skills] 写入发现缓存失败（不影响本次构建）— ${message(error)}`)
  }

  logger.info(
    `[github-skills] 自动发现 ${merged.length} 个公开仓库（主题：${opts.topics.join('、')}，≥${opts.minStars}★）`,
  )
  return withTriage(filterDiscovered(merged, opts), opts.quality)
}

/**
 * 合并同一仓库的多条检索结果。
 *
 * 刻意**不在这里**跑阶段 1：命中发现缓存时会走filterDiscovered 直接返回，
 * 判定放在 mergeDiscovered 里就只在缓存失效时才执行一次。
 * 判定统一交给 withTriage()，两条路径都会走到。
 */
function mergeDiscovered(found: DiscoveredRepo[]): DiscoveredRepo[] {
  const byRepo = new Map<string, DiscoveredRepo>()
  for (const item of found) {
    const key = item.repo.toLowerCase()
    const existing = byRepo.get(key)
    if (!existing || item.stars > existing.stars) byRepo.set(key, item)
  }
  return [...byRepo.values()].sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo))
}

/**
 * 给候选列表补上阶段 1 判定。
 *
 * 只有 SKIP 会让仓库离开队列；REVIEW 仍然入库 ——
 * 实测 165/300 个发现仓库命中 S3（单仓 >5 个 skill），
 * 而它们装着全站 98.4% 的 skill，把 REVIEW 当成「不入库」会直接掏空站点。
 *
 * 旧版发现缓存没有 meta 字段，此时用现有字段合成一份最小元数据：
 * 缺字段只会让判定停在「证据不足」，不会误杀（规则对缺失字段一律降级而非拒绝）。
 */
function withTriage(repos: DiscoveredRepo[], quality?: QualityGate): DiscoveredRepo[] {
  return repos.map(item => {
    if (item.meta) {
      return { ...item, triage: item.triage ?? judgeMetadata(item.meta, { quality }) }
    }
    /*
     * 旧版发现缓存没有 meta 字段（升级前的格式），只能合成最小元数据。
     *
     * 这里必须传 allowMissingLicense：许可证我们**根本没查**，
     * 报成「未探测到许可证 → R5」是误导 —— 而且会让 300 个仓库
     * 在发现缓存刷新之前一直挂着同一个假标记。
     * 「没查」和「查了没有」是两件事，规则要分得清。
     */
    const meta: RepoMeta = {
      repo: item.repo,
      stars: item.stars,
      description: '',
      last_push: item.pushedAt,
      default_branch: item.branch,
    }
    /*
     * 旧缓存路径不套质量门槛：它连 star 之外的元数据都没有，
     * forks 恒为 undefined，照门槛判定会把全部仓库按 Q2 砍掉。
     * 等下一次发现刷新（TTL 到期）拿到完整元数据后门槛自然生效。
     */
    return { ...item, meta, triage: item.triage ?? judgeMetadata(meta, { allowMissingLicense: true }) }
  })
}

function filterDiscovered(repos: DiscoveredRepo[], opts: DiscoverOptions): DiscoveredRepo[] {
  const exclude = new Set((opts.exclude ?? []).map(repo => repo.toLowerCase()))
  return repos.filter(item => !exclude.has(item.repo.toLowerCase())).slice(0, opts.maxRepos)
}

function discoveryCacheFresh(cached: DiscoveryCacheFile, opts: DiscoverOptions): boolean {
  if (cached.topics.join(',') !== opts.topics.join(',') || cached.minStars !== opts.minStars) return false
  // 发现上限提高后需要重新检索补足仓库
  if (cached.repos.length < opts.maxRepos) return false
  const age = Date.now() - Date.parse(cached.fetchedAt)
  return Number.isFinite(age) && age >= 0 && age < opts.ttlHours * 3_600_000
}

/* ------------------------------ 仓库加载 ------------------------------ */

async function loadRepo(
  context: LoaderContext,
  cfg: RemoteRepo,
  opts: LoadRepoOptions,
  state: LoadState,
  aiCache: AiCacheFile,
): Promise<number> {
  const { store, logger, parseData, renderMarkdown, generateDigest, config } = context
  const [owner, name] = cfg.repo.split('/')
  if (!owner || !name) {
    logger.warn(`[github-skills] 忽略无效仓库配置 "${cfg.repo}"（应为 owner/name）`)
    return 0
  }

  const strict = cfg.strict !== false

  /*
   * 显式配置的仓库可能不在自动发现的前 N 名里（实测 anthropics/skills 有 18 万星，
   * 仍可能因 id 去重跌出前 300），此时侧栏会完全没有热度数据。
   * 这里对「没有 stars 且尚未尝试过」的仓库补一次 API 查询，
   * 并把结果写进语料缓存，后续构建不再重复请求。
   */
  if (cfg.stars == null && !cfg.noStarsLookup) {
    try {
      const info = await ghJson<{ stargazers_count: number }>(`${opts.apiBase}/repos/${cfg.repo}`, opts.token)
      cfg.stars = info.stargazers_count
    } catch (error) {
      // 拿不到 stars 不影响构建：仅少一个展示项
      logger.warn(`[github-skills] ${cfg.repo}: 获取 star 数失败，跳过热度展示 — ${message(error)}`)
      cfg.noStarsLookup = true
    }
  }

  const cacheFile = cacheFilePath(opts.cacheDir, config.root, owner, name)
  const cached = readCache(cacheFile)
  const cachedFiles = cached?.files ?? {}
  // 单仓上限 =「仓库上限配置」与「全局剩余额度」的较小值
  const repoCap = Math.min(cfg.maxSkills ?? opts.perRepoMaxSkills, opts.maxSkillsLeft)
  // 上次因单仓上限被截断、且本次上限更高 → 必须重新拉取文件树
  const capGrew = Boolean(cached?.cappedFiles && repoCap > Object.keys(cachedFiles).length)
  const unchanged =
    Boolean(cfg.pushedAt && cached?.pushedAt === cfg.pushedAt && cached?.ref) && !capGrew

  let ref = cfg.branch || cached?.ref || ''
  let treeSha = ''
  let files: SkillFileRef[] = []
  let cacheOnly = false
  let skippedFetch = false

  if (unchanged && cached) {
    // 仓库未推送新提交：全部走缓存，0 次网络请求
    ref = cached.ref
    treeSha = cached.treeSha
    files = cachedFileList(cached.files, cfg)
    cacheOnly = true
    skippedFetch = true
  } else if (state.rateLimited) {
    if (cached) {
      ref = cached.ref
      treeSha = cached.treeSha
      files = cachedFileList(cached.files, cfg)
      cacheOnly = true
    } else {
      logger.warn(`[github-skills] ${cfg.repo}: API 限额已用尽且无缓存，跳过`)
      return 0
    }
  } else {
    try {
      if (!ref) {
        const info = await ghJson<{ default_branch: string }>(`${opts.apiBase}/repos/${cfg.repo}`, opts.token)
        ref = info.default_branch
      }
      const tree = await ghJson<TreeResponse>(
        `${opts.apiBase}/repos/${cfg.repo}/git/trees/${encodePathSegments(ref)}?recursive=1`,
        opts.token,
      )
      treeSha = tree.sha
      files = tree.tree
        .filter(item => item.type === 'blob' && isSkillFile(item.path, cfg))
        .map(item => ({ path: item.path, sha: item.sha, size: item.size ?? 0 }))
      if (tree.truncated) {
        logger.warn(`[github-skills] ${cfg.repo}: 文件树被 GitHub 截断，可能漏掉部分 skill`)
      }
    } catch (error) {
      if (error instanceof GitHubRequestError && error.rateLimited) state.rateLimited = true
      if (cached) {
        logger.warn(`[github-skills] ${cfg.repo}: 拉取失败，改用缓存（${cached.fetchedAt}）— ${message(error)}`)
        ref = cached.ref
        treeSha = cached.treeSha
        files = cachedFileList(cached.files, cfg)
        cacheOnly = true
      } else if (strict) {
        throw new Error(`[github-skills] ${cfg.repo}: 拉取失败且无可用缓存 — ${message(error)}`)
      } else {
        logger.warn(`[github-skills] ${cfg.repo}: 拉取失败且无缓存，跳过 — ${message(error)}`)
        return 0
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  const cappedFiles = files.length > repoCap
  if (cappedFiles) {
    logger.warn(`[github-skills] ${cfg.repo}: ${files.length} 个 skill 超过上限 ${repoCap}，取路径排序前 ${repoCap} 个`)
    files = files.slice(0, repoCap)
  }

  const treeUnchanged = !cacheOnly && cached != null && cached.ref === ref && cached.treeSha === treeSha

  /*
   * 阶段 2：轻量文件探测。
   *
   * 只在「自动发现且未显式豁免」的仓库上跑 —— 手工配置的仓库不受影响。
   * 复用已经取到的文件树，**不额外请求**；README 只在必要时读一次（见下），
   * 判定结果写进缓存，仓库未变更时复用。
   */
  if (cfg.triage && !cfg.exemptFromTriage) {
    /*
     * 缓存里已有阶段 2 结论时**无论是否限流都沿用**。
     *
     * 那个结论当初是靠证据（文件树 + README）得出的，重新认定一次不需要额外请求；
     * 而限流时若跳过它，会让已判 SKIP 的仓库被「洗回」PASS ——
     * 收尾那次 recordTriage 还会用阶段 1 的结论把 SKIP 覆盖掉，日志也跟着说谎。
     */
    const cachedVerdict = cacheOnly || treeUnchanged ? cached?.triage : undefined
    if (cachedVerdict) {
      cfg.triage = cachedVerdict
      recordTriage(state, cfg, cachedVerdict, cached ? cachedFileList(cached.files, cfg).map(f => f.path) : [])
      if (cachedVerdict.decision === 'SKIP') {
        logger.warn(`[github-skills] ${cfg.repo}: 阶段 2 判定 SKIP（${cachedVerdict.reason_code}），沿用缓存结论`)
        return 0
      }
    } else if (state.rateLimited) {
      // 没有历史结论可沿用，且限流下不做新探测 —— 保留阶段 1 的判定
      logger.info(`[github-skills] ${cfg.repo}: 限流中，跳过阶段 2 探测`)
    } else {
      const probe = await buildProbe(cfg, ref, files, opts, config.root, logger)
      const verdict = probe
        ? judgeProbe(probe, cfg.triage, {
            knownRepos: knownSkillPaths(opts.cacheDir, config.root),
            quality: cfg.quality,
          })
        : null
      if (verdict) {
        cfg.triage = verdict
        recordTriage(state, cfg, verdict, verdict.decision === 'SKIP' ? [] : files.map(f => f.path))
        if (verdict.decision === 'SKIP') {
          logger.warn(`[github-skills] ${cfg.repo}: 阶段 2 判定 SKIP（${verdict.reason_code} ${verdict.reason}）`)
          /*
           * 刻意**不删语料缓存**。
           *
           * 曾在这里 unlink 缓存，理由是「避免下次构建继续用旧内容」。
           * 但 R4 误判一次就等于内容被物理删除 —— `code-yeongyu/oh-my-openagent`
           * 被误判后 60 个 skill 从站��消失（清单 8766 → 8729），且必须重新下载才能回来。
           *
           * 保留缓存的代价只是「下轮构建少更新一点」，收益是误判可一键回退：
           * 规则放宽后直接删掉 cached.triage 或恢复缓存文件即可，内容立刻回来。
           */
          return 0
        }
      }
    }
  }

  if (files.length === 0) {
    logger.warn(`[github-skills] ${cfg.repo}: 未发现 SKILL.md（检查 path/skip 配置）`)
  }

  const nextFiles: Record<string, CachedFile> = {}
  const entries = new Array<CachedFile | undefined>(files.length)
  /** 网络 / 限流类失败（下次构建自动重试） */
  const failures = new Map<string, unknown>()
  /** 内容解析失败（frontmatter 等，本版本内永久跳过；仓库更新后自动重试） */
  const parseFailures = new Map<string, unknown>()
  let loaded = 0
  let fetched = 0
  let reused = 0
  let skipped = 0

  // 并发拉取 + 解析（网络为瓶颈），随后串行写入 store 保证顺序稳定
  await mapConcurrent(files, FILE_FETCH_CONCURRENCY, async (file, index) => {
    const existing = cachedFiles[file.path]
    if (existing != null && (cacheOnly || treeUnchanged || existing.sha === file.sha)) {
      entries[index] = existing
      reused++
      return
    }
    let raw: string
    try {
      raw = await fetchRaw(opts.rawBase, cfg.repo, ref, file.path, opts.token)
    } catch (error) {
      if (existing) {
        logger.warn(`[github-skills] ${cfg.repo}: ${file.path} 拉取失败，改用缓存 — ${message(error)}`)
        entries[index] = existing
        reused++
      } else {
        failures.set(file.path, error)
      }
      return
    }
    try {
      const rendered = await renderMarkdown(raw)
      const frontmatter = (rendered.metadata?.frontmatter ?? {}) as Record<string, unknown>
      entries[index] = { sha: file.sha, frontmatter, body: stripFrontmatter(raw) }
      fetched++
    } catch (error) {
      if (existing) {
        logger.warn(`[github-skills] ${cfg.repo}: ${file.path} 解析失败，改用缓存 — ${message(error)}`)
        entries[index] = existing
        reused++
      } else {
        parseFailures.set(file.path, error)
      }
    }
  })

  if (strict && (failures.size > 0 || parseFailures.size > 0)) {
    const [filePath, error] = [...failures.entries(), ...parseFailures.entries()][0]
    throw new Error(`[github-skills] ${cfg.repo}: ${filePath} 拉取失败且无可用缓存 — ${message(error)}`)
  }

  /*
   * 技能级质量门槛（三级判定）。
   *
   * 仓库通过 Q1-Q3 只说明「值得抓」，不代表每个 SKILL.md 可用。
   * 判定必须发生在写 store 与清单之前 —— 被拒的技能不产页、不进索引，
   * AI 分类也不会为它花钱（阈值来源与全量实测见 src/lib/skill-quality.ts）。
   *
   * 结构分两段：
   *   1) 逐条判定（纯函数，不动 store），汇总本仓全部候选的 verdict
   *   2) 决策时刻再分区：
   *      - 整仓剔除命中 → 全部候选记 SK4（仓库级决策优先于单条原因，
   *        审计据此列出剔除名单）
   *      - 否则 → SK1/SK2 逐条记日志；通过项进入提交（parseData →
   *        跨仓去重 SK3 → store / 清单）
   */
  interface JudgedSkill {
    entry: CachedFile
    id: string
    dir: string
    dirName: string
    verdict: SkillVerdict
  }
  const gate = opts.skillGate
  const judged: JudgedSkill[] = []

  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    const entry = entries[index]
    if (!entry) {
      const error = failures.get(file.path)
      if (error) {
        logger.warn(`[github-skills] ${cfg.repo}: ${file.path} 拉取失败且无缓存，跳过 — ${message(error)}`)
      } else {
        const parseError = parseFailures.get(file.path)
        if (parseError) {
          logger.warn(`[github-skills] ${cfg.repo}: ${file.path} 解析失败且无缓存，跳过 — ${message(parseError)}`)
        }
      }
      continue
    }
    nextFiles[file.path] = entry

    const dir = skillDirectory(file.path)
    const dirName = dir.split('/').filter(Boolean).pop() ?? name
    // id 推导与离线脚本共用 src/lib/skill-id.mjs，避免 AI 记忆库错位
    const id = deriveSkillId(file.path, name)
    if (!id) {
      skipped++
      logger.warn(`[github-skills] ${cfg.repo}: 无法为 ${file.path} 生成 id，已跳过`)
      continue
    }
    if (store.has(id)) {
      skipped++
      logger.warn(`[github-skills] ${cfg.repo}: 跳过 ${dir || name}（id "${id}" 已被本地或其他仓库占用）`)
      continue
    }

    // 未配置门槛时 judgeSkill 收到空对象，恒为 PASS —— 无需分支
    const verdict = judgeSkill(
      { id, repo: cfg.repo, sha: entry.sha, body: entry.body, frontmatter: entry.frontmatter },
      gate ?? {},
    )
    judged.push({ entry, id, dir, dirName, verdict })
  }

  /* 整仓决策：未通过占比严格大于阈值 → 全部候选一并剔除（近全废仓不配代表技能） */
  const repoOutcome = judgeRepoOutcome(judged.map(skill => skill.verdict), gate?.repoJunkRatio)
  if (repoOutcome.drop) {
    logger.warn(`[github-skills] ${cfg.repo}: ${repoOutcome.reason}，整仓剔除 ${judged.length} 个技能`)
    for (const skill of judged) {
      skipped++
      state.skillGate.push({
        repo: cfg.repo,
        id: skill.id,
        sha: skill.entry.sha,
        code: 'SK4',
        reason: repoOutcome.reason,
        bodyChars: skill.entry.body.length,
      })
    }
  } else {
    for (const skill of judged) {
      if (skill.verdict.decision === 'SKIP') {
        skipped++
        state.skillGate.push({
          repo: cfg.repo,
          id: skill.id,
          sha: skill.entry.sha,
          code: skill.verdict.code,
          reason: skill.verdict.reason,
          bodyChars: skill.entry.body.length,
        })
        continue
      }

      /*
       * 仓内同 id 的第二个文件在此被拦下（第一个刚提交进 store）。
       * 阶段 1 的 store.has 只看得见跨仓已提交的技能 —— 提交被推迟后，
       * 本仓的占用情况只能在提交时点检查。语义与旧实现一致：
       * 第二个同 id 文件跳过并告警，不占用判定记录。
       */
      if (store.has(skill.id)) {
        skipped++
        logger.warn(`[github-skills] ${cfg.repo}: 跳过 ${skill.dir || name}（id "${skill.id}" 已被本地或其他仓库占用）`)
        continue
      }

      /*
       * AI 质量审查（第四级判定，记忆库驱动）。
       *
       * ai-classify 在 CI 的「AI 分类」步骤里为每个新增/变更技能调用一次
       * LLM（分类 + 质量双输出），drop 判定在提交时点硬删除 —— 不产页、
       * 不进索引、不进清单。三道放行阀：
       *   - SKILLS_AI_SCREEN=0（opts.aiScreen=false）整体关闭
       *   - 记忆库缺失 / 条目 sha 或 prompt 版本不匹配 → 视为未判定，放行
       *   - 只在 store.has 之后、dedupe 之前拦截（被删的技能不占用去重名额）
       */
      if (opts.aiScreen !== false) {
        const aiVerdict = lookupAiQuality(aiCache, skill.id, skill.entry.sha, AI_PROMPT_VERSION)
        if (aiVerdict && aiVerdict.quality === 'drop') {
          skipped++
          state.skillGate.push({
            repo: cfg.repo,
            id: skill.id,
            sha: skill.entry.sha,
            code: 'AI1',
            reason: aiVerdict.why || '未通过 AI 质量审查',
            bodyChars: skill.entry.body.length,
          })
          continue
        }
      }

      const data = await parseData({
        id: skill.id,
        data: mapSkillData(skill.entry.frontmatter, {
          cfg,
          owner,
          repo: cfg.repo,
          ref,
          dir: skill.dir,
          dirName: skill.dirName,
          // AI 记忆库优先：内容未变时采用历史 AI 分类结果
          aiCategory: lookupAiCategory(aiCache, skill.id, skill.entry.sha),
        }),
      })
      /*
       * 跨仓去重：同 sha 或同规范化描述保首个。
       * 处理顺序 = 显式配置仓库在前、其余按 star 降序，
       * 因此「先到」天然是更权威的来源（如 anthropics 原件先于第三方副本）。
       */
      const description = describeForAi(data, skill.id)
      if (!state.dedupe.accept(skill.entry.sha, description)) {
        skipped++
        state.skillGate.push({
          repo: cfg.repo,
          id: skill.id,
          sha: skill.entry.sha,
          code: 'SK3',
          reason: '与先收录的技能重复（同内容或同描述）',
          bodyChars: skill.entry.body.length,
        })
        continue
      }
      store.set({ id: skill.id, data, body: skill.entry.body, digest: generateDigest({ data, body: skill.entry.body }) })
      // 收录成功才进清单：被去重挤掉或解析失败的条目不会让 AI 白花钱
      state.manifest.push({
        id: skill.id,
        sha: skill.entry.sha,
        description,
        repo: cfg.repo,
      })
      loaded++
    }
  }

  /*
   * 收尾再记一次：把「实际收录了哪些文件」写进判定日志。
   *
   * 阶段 1/2 的记录只知道文件树；限流降级或缓存复用时更是根本没跑阶段 2。
   * 只有走到这里才知道真正入库了什么 —— fetched 字段必须反映真实结果，
   * 否则日志会声称「未抓取」而清单里明明有它。
   */
  if (cfg.triage) {
    recordTriage(state, cfg, cfg.triage, Object.keys(nextFiles))
  }

  // 有文件拉取失败时不写入 pushedAt：下次构建视为「未变更检测失效」，
  // 重新拉取文件树并重试失败的文件（已成功的文件仍走缓存，不重复下载）。
  const partial = failures.size > 0
  if (partial) {
    logger.warn(`[github-skills] ${cfg.repo}: ${failures.size} 个文件拉取失败，缓存标记为不完整，下次构建自动重试`)
  }

  if (!cacheOnly && ref && treeSha) {
    try {
      writeCache(cacheFile, {
        ref,
        treeSha,
        pushedAt: partial ? undefined : cfg.pushedAt,
        cappedFiles: cappedFiles ? true : undefined,
        // 阶段 2 判定随缓存保存：仓库未变更时复用，省掉每次构建重读 README
        triage: cfg.triage,
        fetchedAt: new Date().toISOString(),
        files: nextFiles,
      })
    } catch (error) {
      logger.warn(`[github-skills] 写入缓存失败（不影响本次构建）— ${message(error)}`)
    }
  }

  logger.info(
    `[github-skills] ${cfg.repo}: 载入 ${loaded} 个 skill（新拉取 ${fetched}，缓存复用 ${reused}，跳过 ${skipped}）` +
      (skippedFetch ? '（仓库未更新，全部来自缓存）' : ''),
  )
  return loaded
}

/**
 * 记录（或覆盖）某个仓库的判定。
 *
 * 同一个仓库可能先在入队时记一条阶段 1、之后阶段 2 再记一条，
 * 也可能只走阶段 1（限流降级 / 缓存复用）。按 repo 覆盖，
 * 保留最后一次也是最精确的那条。
 */
function recordTriage(state: LoadState, cfg: RemoteRepo, verdict: Verdict, fetchedFiles: string[]): void {
  const repo = cfg.repo.toLowerCase()
  const meta = metaOf(cfg)
  const index = state.triage.findIndex(r => r.meta.repo.toLowerCase() === repo)
  const record: TriageRecord = { meta, verdict, fetchedFiles }
  if (index >= 0) state.triage[index] = record
  else state.triage.push(record)
}

/* ------------------------------ 判定辅助 ------------------------------ */

/** 把 RemoteRepo 拼成判定与日志用的 RepoMeta */
function metaOf(cfg: RemoteRepo): RepoMeta {
  return (
    cfg.meta ?? {
      repo: cfg.repo,
      stars: cfg.stars ?? 0,
      description: '',
      last_push: cfg.pushedAt,
    }
  )
}

/**
 * 汇总语料缓存里已有的 skill 路径，供 S8 重复条目判定。
 *
 * 只读缓存、不发请求；缓存目录里可能没有文件，此时返回空集，
 * S8 自然不触发 —— 宁可漏标记，也不要因为读不到就误判重复。
 */
function knownSkillPaths(cacheDir: string | URL | undefined, root: URL): Set<string> {
  const out = new Set<string>()
  try {
    for (const name of fs.readdirSync(cacheDirPath(cacheDir, root))) {
      if (!name.endsWith('.json') || name === DISCOVERY_CACHE_FILE) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(cacheDirPath(cacheDir, root), name), 'utf8')) as CacheFile
        for (const p of Object.keys(parsed.files ?? {})) out.add(p.toLowerCase())
      } catch {
        // 单个缓存损坏不影响其它
      }
    }
  } catch {
    // 缓存目录还不存在（首次构建）
  }
  return out
}

/**
 * 阶段 2 的探测输入。
 *
 * 关键取舍：**只有仓库确实存在 SKILL.md 时才去读 README**。
 * 没有 SKILL.md 的仓库阶段 1 的 R1 就能定案（judgeProbe 会先判 skillFiles.length === 0），
 * 为此多花一次 raw 请求纯属浪费 —— 实测 300 个发现仓库里有 31 个属于这种情况。
 *
 * 返回 null 表示「信息不足、不下结论」，此时调用方保留阶段 1 的判定。
 */
async function buildProbe(
  cfg: RemoteRepo,
  ref: string,
  files: SkillFileRef[],
  opts: ResolvedOptions,
  root: URL,
  logger: LoaderContext['logger'],
): Promise<RepoProbe | null> {
  const skillFiles = files.map(f => f.path)
  let readme = ''
  if (skillFiles.length > 0) {
    const candidates = ['README.md', 'readme.md', 'README.rst', 'README.txt']
    for (const name of candidates) {
      try {
        readme = await fetchRaw(opts.rawBase, cfg.repo, ref, name, opts.token)
        if (readme) break
      } catch {
        // 试下一个候选名
      }
    }
    if (!readme) {
      logger.info(`[github-skills] ${cfg.repo}: 未取到 README，阶段 2 按「无 README」判定`)
    }
  }

  /*
   * token 估算：优先用文件树里 blob 的字节数。
   *
   * 缓存正文次之（同样免费）。两者都拿不到时返回 -1 表示「未知」，
   * judgeProbe 见到负数会跳过 R8 —— **绝不拿「未知」当「内容为空」**。
   *
   * 这里原本回退成「每文件 64 字符」，冷重建时 1 个文件算出 16 token，
   * 于是每次从零抓取都会把一批好仓库按「内容过薄」砍掉
   * （实测 star 前 50 的仓库里 16 个被 R8 误杀，估值全是 16/32/64 这种整数）。
   */
  const [owner, name] = cfg.repo.split('/')
  const cached = readCache(cacheFilePath(opts.cacheDir, root, owner, name ?? ''))
  const bytesFromTree = files.reduce((sum, f) => sum + f.size, 0)
  const bytesFromCache = files.reduce((sum, f) => sum + (cached?.files?.[f.path]?.body?.length ?? 0), 0)
  const totalBytes = bytesFromTree || bytesFromCache

  return {
    paths: skillFiles,
    // 采样给语气类判定（R4/R7），全文给结构类与安全类判定（Q3/R9/R10）
    readme: readme.slice(0, 2_000),
    readmeFull: readme,
    readmeLength: readme.length,
    skillFiles,
    referenceFiles: [],
    scriptFiles: [],
    // 0 = 确实没有任何 skill 正文；负数 = 未知，判定时应跳过 R8
    totalTokens: totalBytes > 0 ? estimateTokens('x'.repeat(totalBytes)) : skillFiles.length === 0 ? 0 : -1,
  }
}

/* ------------------------------ 字段映射 ------------------------------ */

/**
 * 送进 AI 分类的描述文本。
 * 与旧版 ai-classify 脚本的取值顺序保持一致（description → titleEn → id），
 * 否则同一批技能在换算成本时会得到不同的输入，记忆库复用率下降。
 */
function describeForAi(data: Record<string, unknown>, id: string): string {
  const description = asString(data.description)
  const titleEn = asString(data.titleEn)
  return description || titleEn || id
}

/** 把 Agent Skills frontmatter 映射为本站 schema */
function mapSkillData(frontmatter: Record<string, unknown>, ctx: SkillContext): Record<string, unknown> {
  const declaredName = asString(frontmatter.name) ?? ctx.dirName
  const titleEn = titleCase(declaredName) || ctx.dirName
  const descriptionEn = asString(frontmatter.description) || titleEn
  // 可选中文字段：title_zh / description_zh（也接受 title / description）
  const titleZh = asString(frontmatter.title_zh) ?? asString(frontmatter.title)
  const descriptionZh =
    asString(frontmatter.description_zh) ?? asString(frontmatter.title_zh) ?? asString(frontmatter.title)

  const refSegment = encodePathSegments(ctx.ref)
  const dirSegment = encodePathSegments(ctx.dir)
  return {
    title: titleZh ?? titleEn,
    titleEn,
    description: descriptionZh ?? descriptionEn,
    descriptionEn,
    category: pickCategory(frontmatter, ctx),
    tags: dedupe([...asStringArray(frontmatter.tags), ...(ctx.cfg.tags ?? [])]),
    github: dirSegment
      ? `https://github.com/${ctx.repo}/tree/${refSegment}/${dirSegment}`
      : `https://github.com/${ctx.repo}/tree/${refSegment}`,
    author: ctx.owner,
    // 仓库热度：发现阶段随搜索结果一起带回，无需额外请求
    ...(typeof ctx.cfg.stars === 'number' ? { stars: ctx.cfg.stars } : {}),
  }
}

/**
 * 分类：委托给共享规则层（src/lib/classify.mjs），与同步脚本行为完全一致。
 * 规则层按打分制判定，并输出置信度；置信度为 0 表示规则完全无法判断。
 */
function pickCategory(frontmatter: Record<string, unknown>, ctx: SkillContext): CategoryKey {
  // AI 分类结果优先：记忆库按「skill id + 内容 sha」匹配，
  // 上游没改动就复用历史结果，内容变了自动退回规则层重新判定。
  if (ctx.aiCategory) return ctx.aiCategory
  return classifySkill({
    frontmatter,
    dirName: ctx.dirName,
    dir: ctx.dir,
    fallback: ctx.cfg.category ?? 'dev',
    categoryMap: ctx.cfg.categoryMap ?? {},
  }).category
}

/* ------------------------------ 工具函数 ------------------------------ */

// isSkillFile 已移至 src/lib/skill-file.ts（纯函数，可单元测试）
// skillDirectory / slugify 已移至 src/lib/skill-id.mjs（与离线 AI 分类脚本共用）

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\p{L}/gu, char => char.toUpperCase())
}

/** 去掉 Markdown 头部的 YAML frontmatter，返回正文 */
function stripFrontmatter(raw: string): string {
  const match = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  return match ? raw.slice(match[0].length) : raw
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))]
}

function encodePathSegments(value: string): string {
  return value
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/**
 * 缓存里的文件列表还原成 SkillFileRef。
 *
 * size 取缓存正文的字节数；缓存里没有正文（尚未下载）时为 0，
 * 阶段 2 会把「总量为 0」理解成「未知」而不是「内容为空」。
 */
function cachedFileList(files: Record<string, CachedFile>, cfg: RemoteRepo): SkillFileRef[] {
  return Object.entries(files)
    // 缓存里存的是「当初按当时规则筛过的结果」。
    // 若只信任缓存，改了筛选规则也不生效 —— 规则变更会被静默忽略。
    // 所以每次取出缓存都重新过一遍 isSkillFile，
    // 让实时拉取 / 缓存命中 / 限流降级三条路径的过滤语义保持一致。
    .filter(([filePath]) => isSkillFile(filePath, cfg))
    .map(([filePath, file]) => ({
      path: filePath,
      sha: file.sha,
      size: file.body ? Buffer.byteLength(file.body, 'utf8') : 0,
    }))
}

/** 以固定并发度执行异步任务（按下标写入结果，保持顺序稳定） */
async function mapConcurrent<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

/* ------------------------------ GitHub 请求 ------------------------------ */

class GitHubRequestError extends Error {
  readonly rateLimited: boolean

  constructor(message: string, options: { rateLimited?: boolean } = {}) {
    super(message)
    this.name = 'GitHubRequestError'
    this.rateLimited = options.rateLimited ?? false
  }
}

function ghHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hamster-skills-loader',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

async function ghJson<T>(url: string, token?: string): Promise<T> {
  const res = await fetchWithTimeout(url, ghHeaders(token))
  if (!res.ok) throw await describeError(res, url)
  return (await res.json()) as T
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchRaw(rawBase: string, repo: string, ref: string, filePath: string, token?: string): Promise<string> {
  const url = `${rawBase}/${repo}/${encodePathSegments(ref)}/${encodePathSegments(filePath)}`
  let lastError: unknown
  for (let attempt = 0; attempt <= RAW_FETCH_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RAW_RETRY_BASE_DELAY_MS * attempt)
    try {
      const res = await fetchWithTimeout(url, ghHeaders(token))
      if (res.ok) return await res.text()
      // 429（限流）与 5xx（服务端抖动）可重试；其余状态码直接失败
      if (res.status !== 429 && res.status < 500) throw new GitHubRequestError(`HTTP ${res.status}：${url}`)
      lastError = new Error(`HTTP ${res.status}：${url}`)
    } catch (error) {
      if (error instanceof GitHubRequestError) throw error
      lastError = error
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error(String(lastError))
}

async function describeError(res: Response, url: string): Promise<GitHubRequestError> {
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return new GitHubRequestError('GitHub API 限流（匿名 60 次/小时），请设置 GITHUB_TOKEN', { rateLimited: true })
  }
  if (res.status === 404) return new GitHubRequestError(`资源不存在（HTTP 404）：${url}`)
  return new GitHubRequestError(`HTTP ${res.status}：${url}`)
}

/* ------------------------------ 缓存 ------------------------------ */

function cacheFilePath(cacheDir: string | URL | undefined, root: URL, owner: string, repo: string): string {
  return path.join(cacheDirPath(cacheDir, root), `${owner}__${repo}.json`)
}

function discoveryCachePath(cacheDir: string | URL | undefined, root: URL): string {
  return path.join(cacheDirPath(cacheDir, root), DISCOVERY_CACHE_FILE)
}

function skillManifestPath(cacheDir: string | URL | undefined, root: URL): string {
  // SKILL_MANIFEST_FILE 是相对项目根的路径（脚本侧按 ROOT 拼接），
  // 而 cacheDirPath() 已经给出了缓存目录本身，这里只取文件名部分。
  return path.join(cacheDirPath(cacheDir, root), path.basename(SKILL_MANIFEST_FILE))
}

function cacheDirPath(cacheDir: string | URL | undefined, root: URL): string {
  if (!cacheDir) return fileURLToPath(new URL(`${DEFAULT_CACHE_DIR}/`, root))
  return cacheDir instanceof URL ? fileURLToPath(cacheDir) : path.resolve(cacheDir)
}

function readCache(file: string): CacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheFile
    return parsed && typeof parsed === 'object' && parsed.files ? parsed : null
  } catch {
    return null
  }
}

function writeCache(file: string, data: CacheFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
}

function readDiscoveryCache(file: string): DiscoveryCacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveryCacheFile
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.repos) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 写出技能清单（原子写：先临时文件再 rename）。
 * 与语料缓存同目录，但不参与增量判定——每次构建无条件重写。
 */
function writeSkillManifest(
  skills: SkillManifestEntry[],
  rateLimited: boolean,
  cacheDir: string | URL | undefined,
  root: URL,
  logger: LoaderContext['logger'],
): void {
  const file = skillManifestPath(cacheDir, root)
  const payload: SkillManifestFile = {
    version: 1,
    builtAt: new Date().toISOString(),
    count: skills.length,
    rateLimited,
    skills,
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
    logger.info(`[github-skills] 已写出技能清单 ${skills.length} 条 → ${path.relative(fileURLToPath(root), file)}`)
  } catch (error) {
    // 清单只服务于离线 AI 分类，写失败不该让构建失败
    logger.warn(`[github-skills] 技能清单写入失败，AI 分类将沿用上一轮结果 — ${message(error)}`)
  }
}

function writeDiscoveryCache(file: string, data: DiscoveryCacheFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
}

/**
 * 写出判定日志（JSON Lines，每行一个仓库）。
 *
 * 与技能清单不同：这份文件**不参与增量判定**，每次构建无条件重写，
 * 内容反映的是「这一次为什么收 / 为什么不收」。
 */
function writeTriageLog(
  records: TriageRecord[],
  cacheDir: string | URL | undefined,
  root: URL,
  logger: LoaderContext['logger'],
): void {
  if (records.length === 0) return
  const file = path.join(cacheDirPath(cacheDir, root), TRIAGE_LOG_FILE)
  const tally = { PASS: 0, REVIEW: 0, SKIP: 0 } as Record<string, number>
  // recordTriage 已按 repo 覆盖，这里每个仓库最多一条
  const lines = records.map(record => {
    tally[record.verdict.decision] = (tally[record.verdict.decision] ?? 0) + 1
    return toJsonLine(record.meta, record.verdict, record.fetchedFiles ?? [])
  })
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    logger.info(
      `[github-skills] 判定日志：PASS ${tally.PASS} / REVIEW ${tally.REVIEW} / SKIP ${tally.SKIP} → ${path.relative(fileURLToPath(root), file)}`,
    )
  } catch (error) {
    // 判定日志只用于排查，写失败不该让构建失败
    logger.warn(`[github-skills] 判定日志写入失败 — ${message(error)}`)
  }
}

/**
 * 写出技能级门槛日志（JSON Lines，每行一个被淘汰的技能）。
 *
 * 与 triage.jsonl 平行：仓库级「为什么整仓不收」看那份，
 * 单个技能「为什么被拒」看这份。每轮构建无条件重写；
 * 被拒技能不产页、不进清单，这份日志是事后回溯的唯一线索，
 * audit 也会读它做汇总（但不作为失败条件）。
 */
function writeSkillGateLog(
  records: SkillGateRecord[],
  keptCount: number,
  cacheDir: string | URL | undefined,
  root: URL,
  logger: LoaderContext['logger'],
): void {
  if (records.length === 0) return
  const file = path.join(cacheDirPath(cacheDir, root), SKILL_GATE_LOG_FILE)
  const tally: Record<string, number> = {}
  const lines = records.map(record => {
    tally[record.code] = (tally[record.code] ?? 0) + 1
    return JSON.stringify(record)
  })
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    const summary = Object.entries(tally)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, n]) => `${code} ${n}`)
      .join(' / ')
    logger.info(
      `[github-skills] 技能级门槛：淘汰 ${records.length} 条（${summary}），保留 ${keptCount} → ${path.relative(fileURLToPath(root), file)}`,
    )
  } catch (error) {
    // 只用于排查与审计，写失败不该让构建失败
    logger.warn(`[github-skills] 技能级门槛日志写入失败 — ${message(error)}`)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
