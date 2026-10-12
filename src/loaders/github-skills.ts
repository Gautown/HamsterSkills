import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Loader, LoaderContext } from 'astro/loaders'
import type { CategoryKey } from '../lib/categories'
import { classifySkill } from '../lib/classify.mjs'
import { AI_CACHE_FILE, loadAiCache, lookupAiCategory } from '../lib/ai-cache.mjs'
import type { AiCacheFile } from '../lib/ai-cache.mjs'

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
}

interface ResolvedOptions {
  apiBase: string
  rawBase: string
  token?: string
  cacheDir?: string | URL
}

interface LoadRepoOptions extends ResolvedOptions {
  maxSkillsLeft: number
  perRepoMaxSkills: number
}

interface LoadState {
  rateLimited: boolean
}

interface TreeResponse {
  sha: string
  truncated?: boolean
  tree: Array<{ path: string; type: string; sha: string }>
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
const DEFAULT_SKIP = ['template', 'templates', '.github', 'node_modules', 'dist', 'build']
const SKILL_FILENAME = 'skill.md'
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
  }
  const defaultSkip = options.defaultSkip ?? DEFAULT_SKIP

  return {
    name: 'github-skills-loader',
    async load(context) {
      const { logger } = context
      const state: LoadState = { rateLimited: false }

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
        queue = [
          ...explicit,
          ...discovered.map(item =>
            // stars 随发现结果一起带下来：搜索接口本来就会返回，无需额外请求
            withDefaults({
              repo: item.repo,
              branch: item.branch,
              pushedAt: item.pushedAt,
              stars: item.stars,
              strict: false,
            }),
          ),
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
        logger.warn(
          '[github-skills] GitHub API 匿名限额（60 次/小时）已用尽，部分仓库本次跳过；设置 GITHUB_TOKEN 可完整聚合',
        )
      }
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
    return filterDiscovered(cached.repos, opts)
  }

  const found: DiscoveredRepo[] = []
  try {
    for (const topic of opts.topics) {
      const query = encodeURIComponent(`topic:${topic} fork:false archived:false stars:>=${opts.minStars}`)
      const data = await ghJson<{
        items: Array<{ full_name: string; stargazers_count: number; pushed_at: string; default_branch?: string }>
      }>(`${resolved.apiBase}/search/repositories?q=${query}&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}`, resolved.token)
      for (const item of data.items ?? []) {
        found.push({
          repo: item.full_name,
          stars: item.stargazers_count,
          pushedAt: item.pushed_at,
          branch: item.default_branch,
        })
      }
    }
  } catch (error) {
    if (cached) {
      logger.warn(`[github-skills] 自动发现请求失败，改用缓存（${cached.fetchedAt}）— ${message(error)}`)
      return filterDiscovered(cached.repos, opts)
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
  return filterDiscovered(merged, opts)
}

function mergeDiscovered(found: DiscoveredRepo[]): DiscoveredRepo[] {
  const byRepo = new Map<string, DiscoveredRepo>()
  for (const item of found) {
    const key = item.repo.toLowerCase()
    const existing = byRepo.get(key)
    if (!existing || item.stars > existing.stars) byRepo.set(key, item)
  }
  return [...byRepo.values()].sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo))
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
  let files: Array<{ path: string; sha: string }> = []
  let cacheOnly = false
  let skippedFetch = false

  if (unchanged && cached) {
    // 仓库未推送新提交：全部走缓存，0 次网络请求
    ref = cached.ref
    treeSha = cached.treeSha
    files = cachedFileList(cached.files)
    cacheOnly = true
    skippedFetch = true
  } else if (state.rateLimited) {
    if (cached) {
      ref = cached.ref
      treeSha = cached.treeSha
      files = cachedFileList(cached.files)
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
      files = tree.tree.filter(item => item.type === 'blob' && isSkillFile(item.path, cfg))
      if (tree.truncated) {
        logger.warn(`[github-skills] ${cfg.repo}: 文件树被 GitHub 截断，可能漏掉部分 skill`)
      }
    } catch (error) {
      if (error instanceof GitHubRequestError && error.rateLimited) state.rateLimited = true
      if (cached) {
        logger.warn(`[github-skills] ${cfg.repo}: 拉取失败，改用缓存（${cached.fetchedAt}）— ${message(error)}`)
        ref = cached.ref
        treeSha = cached.treeSha
        files = cachedFileList(cached.files)
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
  if (files.length === 0) {
    logger.warn(`[github-skills] ${cfg.repo}: 未发现 SKILL.md（检查 path/skip 配置）`)
  }

  const treeUnchanged = !cacheOnly && cached != null && cached.ref === ref && cached.treeSha === treeSha
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
    const id = slugify(dirName) || slugify(name)
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

    const data = await parseData({
      id,
      data: mapSkillData(entry.frontmatter, {
        cfg,
        owner,
        repo: cfg.repo,
        ref,
        dir,
        dirName,
        // AI 记忆库优先：内容未变时采用历史 AI 分类结果
        aiCategory: lookupAiCategory(aiCache, id, entry.sha),
      }),
    })
    store.set({ id, data, body: entry.body, digest: generateDigest({ data, body: entry.body }) })
    loaded++
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

/* ------------------------------ 字段映射 ------------------------------ */

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

function isSkillFile(filePath: string, cfg: RemoteRepo): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const lower = normalized.toLowerCase()
  if (lower !== SKILL_FILENAME && !lower.endsWith(`/${SKILL_FILENAME}`)) return false

  let relative = normalized
  const prefix = cfg.path?.replace(/^\/+|\/+$/g, '')
  if (prefix) {
    if (!normalized.startsWith(`${prefix}/`)) return false
    relative = normalized.slice(prefix.length + 1)
  }
  return !(cfg.skip ?? []).some(skip => relative === skip || relative.startsWith(`${skip}/`))
}

function skillDirectory(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/')
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Windows 保留设备名（con/aux/nul 等）不能作为目录名
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `${slug}-skill` : slug
}

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

function cachedFileList(files: Record<string, CachedFile>): Array<{ path: string; sha: string }> {
  return Object.entries(files).map(([filePath, file]) => ({ path: filePath, sha: file.sha }))
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

function writeDiscoveryCache(file: string, data: DiscoveryCacheFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
