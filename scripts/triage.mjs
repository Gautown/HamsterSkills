#!/usr/bin/env node
/**
 * Skill 仓库抓取器 —— 独立运行版，按规范输出 JSON Lines。
 *
 * 构建期 loader（src/loaders/github-skills.ts）复用同一套判定规则，
 * 本脚本把判定过程完整地摊开给人看：每个候选仓库一行 JSON，
 * 包含判定、原因码、置信度、实际抓了哪些文件。
 *
 * 用法：
 *   node scripts/triage.mjs --queries "claude skills,cursor rules"
 *   node scripts/triage.mjs --queries "agent skills" --max-results 40 --min-stars 10
 *   node scripts/triage.mjs --queries "SKILL.md" --language TypeScript --out .cache/triage.jsonl
 *
 * 输出：JSON Lines（每行一个 JSON 对象），不套 markdown 代码块，不加额外文字。
 */
import fs from 'node:fs'
import path from 'node:path'
import { judgeMetadata, judgeProbe, estimateTokens, planFetch, toJsonLine } from '../src/lib/triage.ts'

/* ------------------------------ 参数 ------------------------------ */

/**
 * fetched_files 列出上限。
 *
 * 规范示例是 ["SKILL.md","README.md"] 这种短列表；不封顶的话
 * 一个 200 个 skill 的大仓会输出一行几百 KB 的 JSON，
 * 之后没有任何工具能舒服地读这个文件。
 */
const MAX_LISTED_FILES = 20

/** 给 fetched_files 封顶，超出部分用一条汇总代替 */
function truncateFiles(files) {
  if (files.length <= MAX_LISTED_FILES) return files
  const rest = files.length - MAX_LISTED_FILES
  return [...files.slice(0, MAX_LISTED_FILES), `…另有 ${rest} 项未列出`]
}

function parseArgs(argv) {
  const out = {
    queries: [],
    maxResults: 50,
    minStars: 0,
    language: null,
    out: null,
    token: process.env.GITHUB_TOKEN,
    /** 阶段 3 只抓 README 与文件列表，不落完整 SKILL.md 正文（省带宽） */
    listOnly: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--queries') out.queries = next().split(',').map(s => s.trim()).filter(Boolean)
    else if (arg === '--max-results') out.maxResults = Number(next())
    else if (arg === '--min-stars') out.minStars = Number(next())
    else if (arg === '--language') out.language = next()
    else if (arg === '--out') out.out = next()
    else if (arg === '--token') out.token = next()
    else if (arg === '--list-only') out.listOnly = true
    else if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

const HELP = `Skill 仓库抓取器

  --queries "<a,b,c>"      搜索关键词（必填）
  --max-results <n>        本次最多处理的候选仓库数（默认 50）
  --min-stars <n>          最低 star 阈值（默认 0，不强制）
  --language <lang>        限定语言
  --out <file>             JSON Lines 输出文件（默认只写 stdout）
  --token <token>          GitHub Token（默认读 GITHUB_TOKEN）
  --list-only              阶段 3 只列文件，不落完整正文
`

/* --------------------------- GitHub 访问 --------------------------- */

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
/** 规范要求：每个仓库请求间隔 ≥ 1 秒 */
const REQUEST_SPACING_MS = 1_100
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RETRIES = 3

let lastRequestAt = 0

/** 串行节流：确保任意两次 GitHub 请求间隔 ≥ REQUEST_SPACING_MS */
async function throttle() {
  const wait = lastRequestAt + REQUEST_SPACING_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 带退避的请求。
 *
 * 403/429 按规范退避重试：GitHub 的匿名限额是每小时 60 次，
 * 重试间隔按 2 的幂退避，最多重试 MAX_RETRIES 次。
 */
async function request(url, { token, accept = 'application/vnd.github+json' } = {}) {
  let lastError
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1_000)
    await throttle()
    try {
      const res = await fetch(url, {
        headers: {
          Accept: accept,
          'User-Agent': 'hamster-skill-triage',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.ok) return res

      const retryable = res.status === 403 || res.status === 429 || res.status >= 500
      lastError = new Error(`HTTP ${res.status}`)
      if (!retryable) throw lastError
      if (res.status === 403 || res.status === 429) {
        lastError.message +=
          `（限流，x-ratelimit-remaining=${res.headers.get('x-ratelimit-remaining') ?? '未知'}）`
      }
    } catch (error) {
      lastError = error
      // 非 HTTP 类错误（网络抖动）也退避重试
    }
  }
  throw lastError ?? new Error('请求失败')
}

const ghJson = async (url, opts) => (await request(url, opts)).json()
const rawText = async (url, opts) => (await request(url, { ...opts, accept: 'text/plain' })).text()

/* ------------------------------ 抓取 ------------------------------ */

/** 候选检索：规范给的是 search_queries，按关键词逐个搜 */
async function discover(queries, { maxResults, minStars, language, token }) {
  const seen = new Map()
  for (const q of queries) {
    const parts = [`"${q}"`, 'in:name,description,readme', `stars:>=${minStars}`]
    if (language) parts.push(`language:${language}`)
    const url = `${API}/search/repositories?q=${encodeURIComponent(parts.join(' '))}&sort=stars&order=desc&per_page=100`
    try {
      const data = await ghJson(url, { token })
      for (const item of data.items ?? []) {
        if (!seen.has(item.full_name)) seen.set(item.full_name, item)
      }
    } catch (error) {
      // 单个关键词失败不应中断整轮：其余关键词仍可能有结果
      process.stderr.write(`# 检索「${q}」失败：${error.message}\n`)
    }
  }
  return [...seen.values()].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, maxResults)
}

const toMeta = repo => ({
  repo: repo.full_name,
  stars: repo.stargazers_count,
  description: repo.description ?? '',
  language: repo.language,
  archived: repo.archived,
  fork: repo.fork,
  license: repo.license?.spdx_id ?? null,
  last_push: repo.pushed_at,
  created_at: repo.created_at,
  open_issues: repo.open_issues_count,
  topics: repo.topics ?? [],
})

/** 阶段 2：只读文件树 + README 前 2000 字符 */
async function probeRepo(meta, { token }) {
  const readmeLimit = 2000
  let ref = meta.default_branch
  const treeRes = await request(
    `${API}/repos/${meta.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { token },
  )
  if (!treeRes.ok) throw new Error(`文件树 HTTP ${treeRes.status}`)
  const tree = await treeRes.json()

  const paths = (tree.tree ?? []).filter(n => n.type === 'blob').map(n => n.path)
  const skillFiles = paths.filter(p => p.toLowerCase().endsWith('/skill.md') || p.toLowerCase() === 'skill.md')
  const referenceFiles = paths.filter(p => /(^|\/)references?\//i.test(p))
  const scriptFiles = paths.filter(p => /(^|\/)scripts?\//i.test(p))

  // README：树里有哪个取哪个，都没有就取 README.md 兜底
  const readmePath = paths.find(p => /^readme(\.md|\.rst|\.txt)?$/i.test(p)) ?? 'README.md'
  let readme = ''
  try {
    readme = await rawText(`${RAW}/${meta.repo}/${encodeURIComponent(ref)}/${encodePath(readmePath)}`, { token })
  } catch {
    readme = ''
  }

  /*
   * 阶段 2 不下载 SKILL.md 正文，但 R8（内容过薄）需要 token 估算。
   * 这里用文件树里的 blob 大小做等效估算：GitHub 的 tree 返回 size，
   * 与正文长度同量级，足以区分「几十 token」与「几千 token」。
   */
  const sizes = (tree.tree ?? [])
    .filter(n => n.type === 'blob' && skillFiles.includes(n.path))
    .map(n => n.size ?? 0)
  const totalTokens = estimateTokens('x'.repeat(sizes.reduce((a, b) => a + b, 0)))

  return {
    paths,
    readme: readme.slice(0, readmeLimit),
    readmeLength: readme.length,
    skillFiles,
    referenceFiles,
    scriptFiles,
    totalTokens,
  }
}

const encodePath = p => p.split('/').map(encodeURIComponent).join('/')

/* ------------------------------ 主流程 ------------------------------ */

const args = parseArgs(process.argv)
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (args.queries.length === 0) {
  process.stderr.write(HELP)
  process.exit(2)
}

const lines = []
const emit = (meta, verdict, fetchedFiles) => {
  const line = toJsonLine(meta, verdict, fetchedFiles)
  lines.push(line)
  process.stdout.write(`${line}\n`)
}

const candidates = await discover(args.queries, args)
if (candidates.length === 0) {
  process.stderr.write('# 没有检索到候选仓库\n')
}

for (const repo of candidates) {
  const meta = { ...toMeta(repo), default_branch: repo.default_branch }

  /* ---- 阶段 1：元数据预筛 ---- */
  const stage1 = judgeMetadata(meta)
  if (stage1.decision === 'SKIP') {
    emit(meta, stage1)
    continue
  }

  /* ---- 阶段 2：轻量文件探测 ---- */
  let probeResult
  try {
    probeResult = await probeRepo(meta, { token: args.token })
  } catch (error) {
    // 信息不足不猜测：交给人工看
    emit(meta, { decision: 'REVIEW', reason_code: 'MISSING_INFO', reason: `文件树获取失败：${error.message}`.slice(0, 40), confidence: 0.3 })
    continue
  }
  const stage2 = judgeProbe(probeResult, stage1)
  if (stage2.decision === 'SKIP') {
    emit(meta, stage2)
    continue
  }

  /* ---- 阶段 3：按判定结果抓取 ---- */
  const plan = planFetch(stage2, probeResult)
  const fetchedFiles = []
  if (plan.fetched) {
    fetchedFiles.push(...probeResult.skillFiles.slice(0, plan.maxFiles))
    fetchedFiles.push(...probeResult.referenceFiles.slice(0, plan.referenceFileLimit))
    /*
     * scripts/ 只记文件名、不取内容（除非显式 --include-scripts）。
     * 而且**只记一条汇总**：实测单仓脚本数可达 179 个，
     * 逐条列出来会把一行 JSON 撑到几十 KB，日志根本没法看。
     */
    if (probeResult.scriptFiles.length > 0) {
      fetchedFiles.push(`scripts/ ×${probeResult.scriptFiles.length}（未下载内容）`)
    }
    if (!args.listOnly && stage2.decision === 'PASS') {
      // PASS 才真正落 SKILL.md 正文
      for (const skillPath of probeResult.skillFiles) {
        try {
          const body = await rawText(
            `${RAW}/${meta.repo}/${encodeURIComponent(meta.default_branch)}/${encodePath(skillPath)}`,
            { token: args.token },
          )
          if (body) fetchedFiles.push(`${skillPath} (${body.length} 字符)`)
        } catch {
          // 单个文件失败不影响其余
        }
      }
    }
  }
  emit(meta, stage2, truncateFiles(fetchedFiles))
}

if (args.out) {
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
  fs.writeFileSync(args.out, `${lines.join('\n')}\n`, 'utf8')
  process.stderr.write(`# 已写出 ${lines.length} 行 → ${args.out}\n`)
}

/*
 * 汇总打到 stderr。
 * stdout 严格只留 JSON Lines —— 规范要求「只输出 JSON Lines，
 * 不要 markdown 代码块，不要额外文字」，因此统计信息一律走 stderr。
 */
const tally = {}
for (const line of lines) {
  const d = JSON.parse(line)
  tally[d.decision] = (tally[d.decision] ?? 0) + 1
}
process.stderr.write(
  `# 合计 ${lines.length} 个：PASS ${tally.PASS ?? 0} / REVIEW ${tally.REVIEW ?? 0} / SKIP ${tally.SKIP ?? 0}\n`,
)