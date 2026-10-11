#!/usr/bin/env node
/**
 * 每日 GitHub 技能同步脚本（数据层同步，不触发站点构建）
 *
 * 用法：npm run sync
 *   node scripts/sync-skills.mjs            # 正常同步
 *   node scripts/sync-skills.mjs --force    # 忽略增量判定，强制重扫全部目标仓库
 *   node scripts/sync-skills.mjs --dry-run  # 只统计将要发生的变化，不写文件
 *
 * 行为（按 skill id 覆盖）：
 *   1. 读取 .cache/skills-remote/ 现有缓存作为「已收录」基线
 *   2. 主题发现 → 新增仓库入队；变更仓库（pushedAt 变化）入队
 *   3. 逐仓拉文件树，仅下载新增/变更的 SKILL.md（raw 不消耗 API 配额）
 *   4. 按 skill id 合并：已有 id 覆盖内容，新 id 追加
 *   5. 写出 data/skills.json（统一数据文件，供站点构建期读取）
 *
 * 环境变量：见 .env.example（SKILLS_* / GITHUB_TOKEN）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 分类规则与站点构建时共用同一份实现，避免两处逻辑漂移
import { classifySkill } from '../src/lib/classify.mjs'
import { AI_CACHE_FILE, loadAiCache, lookupAiCategory } from '../src/lib/ai-cache.mjs'

/* ------------------------------ 配置 ------------------------------ */

/** @typedef {import('../src/lib/classify.mjs').CategoryKey} CategoryKey */

const ROOT = process.cwd()
const CACHE_DIR = path.join(ROOT, '.cache', 'skills-remote')
const DATA_DIR = path.join(ROOT, 'data')
const DATA_FILE = path.join(DATA_DIR, 'skills.json')
const DISCOVERY_FILE = path.join(CACHE_DIR, '_discovery.json')

const DEFAULT_TOPICS = 'agent-skills,claude-skills,claude-code-skills,opencode-skills,opencode-skill,hermes-skills'
const DEFAULT_SKIP = ['template', 'templates', '.github', 'node_modules', 'dist', 'build']
const SKILL_FILENAME = 'skill.md'
const SEARCH_PER_PAGE = 100
const FETCH_TIMEOUT_MS = 30_000
const FILE_FETCH_CONCURRENCY = 8
const RAW_FETCH_RETRIES = 2
const RAW_RETRY_BASE_DELAY_MS = 700

/**
 * 环境变量读取。注意：Windows 上「同名但非数字的环境变量」会被 PowerShell 缓存为字符串 "0"
 * （如 $env:FOO='abc' 后 $env:FOO 实际为 '0'），因此这里必须校验数字合法性，
 * 不能用 `process.env.X || fallback` 这种「空串判断」。
 */
function envStr(name, fallback = '') {
  const v = process.env[name]
  if (v === undefined || v === null || v === '') return fallback
  return v
}

function envNum(name, fallback) {
  const raw = envStr(name, '').trim()
  if (raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    warn(`${name}="${raw}" 不是合法数字，回退默认值 ${fallback}`)
    return fallback
  }
  return n
}

const CONFIG = {
  token: envStr('GITHUB_TOKEN') || undefined,
  apiBase: envStr('GITHUB_API_BASE', 'https://api.github.com').replace(/\/+$/, ''),
  rawBase: envStr('GITHUB_RAW_BASE', 'https://raw.githubusercontent.com').replace(/\/+$/, ''),
  topics: envStr('SKILLS_TOPICS', DEFAULT_TOPICS).split(',').map(s => s.trim()).filter(Boolean),
  minStars: envNum('SKILLS_MIN_STARS', 0),
  maxRepos: envNum('SKILLS_MAX_REPOS', 300),
  discoveryTtlHours: envNum('SKILLS_DISCOVER_TTL_HOURS', 24),
  perRepoMaxSkills: envNum('SKILLS_MAX_SKILLS_PER_REPO', 200),
  maxSkills: envNum('SKILLS_MAX_SKILLS', 12000),
  skip: DEFAULT_SKIP,
}

/* ------------------------------ 日志 ------------------------------ */

const stats = {
  started: Date.now(),
  discovered: 0,
  newRepos: 0,
  changedRepos: 0,
  unchangedRepos: 0,
  filesFetched: 0,
  filesReused: 0,
  added: 0,
  updated: 0,
  reused: 0,
  collisions: 0,
  reposFailed: 0,
  rateLimited: false,
}

function log(msg) {
  const elapsed = ((Date.now() - stats.started) / 1000).toFixed(1)
  console.log(`[sync +${elapsed}s] ${msg}`)
}
function warn(msg) {
  console.warn(`[sync] ⚠ ${msg}`)
}

/* ------------------------------ GitHub 客户端 ------------------------------ */

class GitHubRequestError extends Error {
  /** @param {string} message @param {{ rateLimited?: boolean }} [options] */
  constructor(message, options = {}) {
    super(message)
    this.name = 'GitHubRequestError'
    this.rateLimited = options.rateLimited ?? false
  }
}

/** @returns {Record<string,string>} */
function ghHeaders() {
  /** @type {Record<string,string>} */
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hamster-skills-sync' }
  if (CONFIG.token) headers.Authorization = `Bearer ${CONFIG.token}`
  return headers
}

/** @returns {Promise<any>} */
async function ghJson(url) {
  const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw await describeError(res, url)
  return res.json()
}

/** @param {Response} res @param {string} url */
async function describeError(res, url) {
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    return new GitHubRequestError('GitHub API 限流（匿名 60 次/小时），请设置 GITHUB_TOKEN', { rateLimited: true })
  }
  if (res.status === 404) return new GitHubRequestError(`资源不存在（HTTP 404）：${url}`)
  return new GitHubRequestError(`HTTP ${res.status}：${url}`)
}

/** 拉取 raw 文件，429/5xx 自动重试 */
async function fetchRaw(repo, ref, filePath) {
  const url = `${CONFIG.rawBase}/${repo}/${encodePathSegments(ref)}/${encodePathSegments(filePath)}`
  let lastError
  for (let attempt = 0; attempt <= RAW_FETCH_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RAW_RETRY_BASE_DELAY_MS * attempt)
    try {
      const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (res.ok) return await res.text()
      if (res.status !== 429 && res.status < 500) throw new GitHubRequestError(`HTTP ${res.status}：${url}`)
      lastError = new Error(`HTTP ${res.status}：${url}`)
    } catch (error) {
      if (error instanceof GitHubRequestError) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function encodePathSegments(value) {
  return value.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

/** 固定并发度执行，失败不抛出（返回 undefined 占位） */
async function mapConcurrent(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        await worker(items[index], index)
      } catch {
        /* 单项失败不影响整体 */
      }
    }
  })
  await Promise.all(runners)
}

/* ------------------------------ 工具函数 ------------------------------ */

function isSkillFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  const lower = normalized.toLowerCase()
  if (lower !== SKILL_FILENAME && !lower.endsWith(`/${SKILL_FILENAME}`)) return false
  return !CONFIG.skip.some(skip => normalized === skip || normalized.startsWith(`${skip}/`) || normalized.includes(`/${skip}/`))
}

function skillDirectory(filePath) {
  return filePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
}

function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `${slug}-skill` : slug
}

function titleCase(value) {
  return value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\p{L}/gu, c => c.toUpperCase())
}

function stripFrontmatter(raw) {
  const match = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  return match ? raw.slice(match[0].length) : raw
}

function asString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter(i => typeof i === 'string') : []
}

function dedupe(items) {
  return [...new Set(items.map(i => i.trim()).filter(Boolean))]
}

/**
 * 分类：AI 记忆库优先，其次共享规则层（src/lib/classify.mjs）。
 * 与站点构建时（loader）的判定顺序完全一致，保证两边产出的分类不会打架。
 */
function pickCategory(frontmatter, dirName, dir, aiCategory) {
  if (aiCategory) return aiCategory
  return classifySkill({ frontmatter, dirName, dir }).category
}

/** 解析 SKILL.md 文本 → { frontmatter, body, data } */
function parseSkill(raw, ctx) {
  let frontmatter = {}
  let body = stripFrontmatter(raw)
  const fmMatch = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  if (fmMatch) frontmatter = parseSimpleYaml(fmMatch[1])
  const declaredName = asString(frontmatter.name) ?? ctx.dirName
  const titleEn = titleCase(declaredName) || ctx.dirName
  const descriptionEn = asString(frontmatter.description) || titleEn
  const titleZh = asString(frontmatter.title_zh) ?? asString(frontmatter.title)
  const descriptionZh = asString(frontmatter.description_zh) ?? asString(frontmatter.title_zh) ?? asString(frontmatter.title)
  const refSegment = encodePathSegments(ctx.ref)
  const dirSegment = encodePathSegments(ctx.dir)
  return {
    frontmatter,
    body,
    data: {
      title: titleZh ?? titleEn,
      titleEn,
      description: descriptionZh ?? descriptionEn,
      descriptionEn,
      category: pickCategory(frontmatter, ctx.dirName, ctx.dir, ctx.aiCategory),
      tags: dedupe([...asStringArray(frontmatter.tags)]),
      github: dirSegment ? `https://github.com/${ctx.repo}/tree/${refSegment}/${dirSegment}` : `https://github.com/${ctx.repo}/tree/${refSegment}`,
      author: ctx.owner,
    },
  }
}

/** 轻量 YAML 解析：仅支持 frontmatter 常见的标量 / 行内数组 / 简单列表 */
function parseSimpleYaml(text) {
  /** @type {Record<string, any>} */
  const out = {}
  let currentKey = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const listItem = /^\s*-\s+(.*)$/.exec(line)
    if (listItem && currentKey) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = []
      out[currentKey].push(unquote(listItem[1]))
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const value = kv[2].trim()
    currentKey = key
    if (!value) {
      out[key] = []
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = value.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean)
    } else {
      out[key] = unquote(value)
    }
  }
  return out
}

function unquote(value) {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}

/* ------------------------------ 缓存读写 ------------------------------ */

function cacheFileFor(repo) {
  return path.join(CACHE_DIR, `${repo.replace('/', '__')}.json`)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写：先写临时文件再 rename，避免中断产生半截 JSON */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
  fs.renameSync(tmp, file)
}

/* ------------------------------ 阶段 1：主题发现 ------------------------------ */

async function discoverRepos() {
  const cached = readJson(DISCOVERY_FILE)
  const fresh =
    cached &&
    Array.isArray(cached.topics) &&
    cached.topics.join(',') === CONFIG.topics.join(',') &&
    cached.minStars === CONFIG.minStars &&
    Array.isArray(cached.repos) &&
    cached.repos.length >= CONFIG.maxRepos &&
    Date.now() - Date.parse(cached.fetchedAt) < CONFIG.discoveryTtlHours * 3_600_000

  if (fresh && !FORCE) {
    log(`复用发现缓存（${cached.fetchedAt}，${cached.repos.length} 仓）`)
    return cached.repos.slice(0, CONFIG.maxRepos)
  }

  const byRepo = new Map()
  for (const topic of CONFIG.topics) {
    const query = encodeURIComponent(`topic:${topic} fork:false archived:false stars:>=${CONFIG.minStars}`)
    const url = `${CONFIG.apiBase}/search/repositories?q=${query}&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}`
    try {
      const data = await ghJson(url)
      for (const item of data.items ?? []) {
        const key = String(item.full_name).toLowerCase()
        const existing = byRepo.get(key)
        if (!existing || item.stargazers_count > existing.stars) {
          byRepo.set(key, {
            repo: item.full_name,
            stars: item.stargazers_count,
            pushedAt: item.pushed_at,
            branch: item.default_branch,
          })
        }
      }
      log(`主题 ${topic}：累计 ${byRepo.size} 仓`)
    } catch (error) {
      warn(`主题 ${topic} 发现失败：${error instanceof Error ? error.message : String(error)}`)
    }
    await sleep(1500) // 搜索接口限速保护
  }

  const merged = [...byRepo.values()]
    .sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo))
    .slice(0, CONFIG.maxRepos)
  stats.discovered = merged.length
  log(`主题发现完成：${merged.length} 仓`)

  // 发现失败时回退缓存，避免本次同步丢失来源
  const repos = merged.length > 0 ? merged : cached?.repos ?? []
  if (merged.length > 0) {
    writeJsonAtomic(DISCOVERY_FILE, {
      fetchedAt: new Date().toISOString(),
      topics: CONFIG.topics,
      minStars: CONFIG.minStars,
      repos,
    })
  }
  return repos
}

/* ------------------------------ 阶段 2：仓库同步 ------------------------------ */

async function syncRepo(target, aiCache) {
  const cacheFile = cacheFileFor(target.repo)
  const cached = readJson(cacheFile)
  const cachedFiles = (cached && cached.files) || {}

  // 增量判定：pushedAt 未变且缓存完整 → 复用（0 次 API 请求）
  if (!FORCE && cached && cached.pushedAt === target.pushedAt && cached.ref && Object.keys(cachedFiles).length > 0) {
    stats.unchangedRepos++
    return { status: 'unchanged', files: cachedFiles, ref: cached.ref }
  }

  // 本次运行已被限流：剩余仓库全部回退到磁盘缓存，保证数据完整
  if (stats.rateLimited) {
    stats.unchangedRepos++
    return { status: 'cached', files: cachedFiles, ref: cached?.ref ?? '' }
  }

  const [owner, name] = String(target.repo).split('/')
  if (!owner || !name) return { status: 'failed', files: cachedFiles, ref: cached?.ref ?? '' }

  let ref = target.branch || cached?.ref || ''
  let treeSha = ''
  let files = []

  try {
    if (!ref) {
      const info = await ghJson(`${CONFIG.apiBase}/repos/${target.repo}`)
      ref = info.default_branch
    }
    const tree = await ghJson(
      `${CONFIG.apiBase}/repos/${target.repo}/git/trees/${encodePathSegments(ref)}?recursive=1`,
    )
    treeSha = tree.sha
    files = (tree.tree ?? [])
      .filter(item => item.type === 'blob' && isSkillFile(item.path))
      .sort((a, b) => a.path.localeCompare(b.path))
    if (tree.truncated) warn(`${target.repo}：文件树被 GitHub 截断，可能漏掉部分 skill`)
  } catch (error) {
    if (error instanceof GitHubRequestError && error.rateLimited) {
      stats.rateLimited = true
      warn(`${target.repo}：API 限流，后续仓库将全部使用本地缓存`)
      return { status: 'cached', files: cachedFiles, ref: cached?.ref ?? '' }
    }
    warn(
      `${target.repo}：文件树获取失败，改用缓存 — ${error instanceof Error ? error.message : String(error)}`,
    )
    stats.reposFailed++
    return { status: 'cached', files: cachedFiles, ref: cached?.ref ?? '' }
  }

  if (files.length > CONFIG.perRepoMaxSkills) {
    warn(
      `${target.repo}：${files.length} 个 skill 超过单仓上限 ${CONFIG.perRepoMaxSkills}，取路径排序前 ${CONFIG.perRepoMaxSkills} 个`,
    )
    files = files.slice(0, CONFIG.perRepoMaxSkills)
  }

  const nextFiles = {}
  const pending = files.filter(file => !cachedFiles[file.path] || cachedFiles[file.path].sha !== file.sha)

  await mapConcurrent(pending, FILE_FETCH_CONCURRENCY, async file => {
    try {
      const raw = await fetchRaw(target.repo, ref, file.path)
      const dir = skillDirectory(file.path)
      const dirName = dir.split('/').filter(Boolean).pop() ?? name
      const parsed = parseSkill(raw, {
        repo: target.repo,
        owner,
        ref,
        dir,
        dirName,
        aiCategory: lookupAiCategory(aiCache, slugify(dirName) || slugify(name), file.sha),
      })
      nextFiles[file.path] = { sha: file.sha, frontmatter: parsed.frontmatter, body: parsed.body, data: parsed.data }
      stats.filesFetched++
    } catch (error) {
      // 拉取失败时回退已有缓存内容，保证数据不丢失
      const existing = cachedFiles[file.path]
      if (existing) nextFiles[file.path] = existing
      else
        warn(
          `${target.repo}：${file.path} 拉取失败 — ${error instanceof Error ? error.message : String(error)}`,
        )
    }
  })

  for (const file of files) {
    if (!nextFiles[file.path] && cachedFiles[file.path]) {
      nextFiles[file.path] = cachedFiles[file.path]
      stats.filesReused++
    }
  }

  writeJsonAtomic(cacheFile, {
    ref,
    treeSha,
    pushedAt: target.pushedAt,
    fetchedAt: new Date().toISOString(),
    files: nextFiles,
  })
  return {
    status: cached && Object.keys(cachedFiles).length > 0 ? 'changed' : 'new',
    files: nextFiles,
    ref,
  }
}

/* ------------------------------ 阶段 3：按 id 合并 ------------------------------ */

/**
 * 取得一条缓存文件的站点字段。
 * 旧版 loader 写入的缓存只有 {sha, frontmatter, body}，没有 data 字段，
 * 这里现场从 frontmatter 推导，保证历史缓存也能正确参与合并。
 *
 * AI 记忆库优先：缓存里的 data.category 是规则层算的，
 * 若命中记忆库（内容未变）必须覆盖，否则绝大多数条目的 AI 结果会被缓存绕过。
 */
function resolveEntryData(entry, ctx) {
  const base = entry.data && typeof entry.data === 'object'
    ? entry.data
    : entry.frontmatter
      ? parseSkill(buildSyntheticSource(entry.frontmatter), ctx).data
      : undefined
  if (!base) return undefined
  if (!ctx.aiCategory) return base
  return { ...base, category: ctx.aiCategory }
}

/** 用缓存里的 frontmatter 拼一段最小 Markdown，供 parseSkill 复用同一套映射逻辑 */
function buildSyntheticSource(frontmatter) {
  const lines = ['---']
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(v => JSON.stringify(v)).join(', ')}]`)
    else if (value !== undefined && value !== null) lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

/**
 * 以 skill id 为唯一键合并：已有 id 覆盖内容，新 id 追加。
 * 覆盖顺序按 star 降序（高星优先占位），与站点现有 URL 体系保持一致。
 */
function mergeBySkillId(ordered, perRepoFiles, perRepoRefs, baseline, aiCache) {
  const merged = new Map()
  for (const target of ordered) {
    const files = perRepoFiles.get(target.repo)
    if (!files) continue
    for (const [filePath, entry] of Object.entries(files)) {
      const dir = skillDirectory(filePath)
      const dirName = dir.split('/').filter(Boolean).pop() ?? String(target.repo)
      const id = slugify(dirName) || slugify(String(target.repo).split('/')[1])
      if (!id) continue
      const [owner] = String(target.repo).split('/')
      const ref = perRepoRefs.get(target.repo) ?? ''
      const data = resolveEntryData(entry, {
        repo: target.repo,
        owner,
        ref,
        dir,
        dirName,
        aiCategory: lookupAiCategory(aiCache, id, entry.sha),
      })
      if (!data) continue
      const record = {
        id,
        repo: target.repo,
        path: filePath,
        sha: entry.sha,
        data,
        body: entry.body ?? '',
      }
      const existing = merged.get(id)
      if (!existing) {
        merged.set(id, record)
        if (baseline.has(id)) stats.reused++
        else stats.added++
      } else if (existing.repo === record.repo && existing.sha !== entry.sha) {
        // 同一仓库内内容更新 → 真正的「覆盖掉」
        merged.set(id, record)
        stats.updated++
      } else if (existing.repo !== record.repo) {
        // 跨仓库同名冲突：高星仓（先遍历到的）保持占位，低星仓被丢弃，与站点现有行为一致
        stats.collisions++
      }
    }
  }
  return merged
}

/* ------------------------------ 主流程 ------------------------------ */

const args = new Set(process.argv.slice(2))
const FORCE = args.has('--force')
const DRY_RUN = args.has('--dry-run')

async function main() {
  log(
    '开始同步' +
      (FORCE ? '（--force 强制重扫）' : '') +
      (DRY_RUN ? '（--dry-run 不写文件）' : ''),
  )
  log(
    `配置：主题 ${CONFIG.topics.length} 个 / 上限 ${CONFIG.maxRepos} 仓 / 单仓 ${CONFIG.perRepoMaxSkills} / 总量 ${CONFIG.maxSkills} / Token ${CONFIG.token ? '已配置' : '未配置(60 次/时)'}`,
  )

  fs.mkdirSync(CACHE_DIR, { recursive: true })

  // AI 分类记忆库：命中时用 AI 结果覆盖规则层分类（与站点构建时行为一致）
  const aiCache = loadAiCache(path.join(ROOT, AI_CACHE_FILE))
  const aiCached = Object.keys(aiCache.entries).length
  if (aiCached > 0) log(`载入 AI 分类记忆 ${aiCached} 条（内容未变时优先采用）`)

  // 1) 发现
  const discoveryBefore = readJson(DISCOVERY_FILE)
  const knownRepos = new Set((discoveryBefore?.repos ?? []).map(r => String(r.repo).toLowerCase()))
  const targets = await discoverRepos()
  for (const t of targets) if (!knownRepos.has(String(t.repo).toLowerCase())) stats.newRepos++

  // 2) 逐仓同步（串行，避免触发二级限流）
  const perRepoFiles = new Map()
  const perRepoRefs = new Map()
  const ordered = targets.slice().sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo))

  for (let i = 0; i < ordered.length; i++) {
    const target = ordered[i]
    try {
      const result = await syncRepo(target, aiCache)
      perRepoFiles.set(target.repo, result.files)
      perRepoRefs.set(target.repo, result.ref || target.branch || '')
      if (result.status === 'new' || result.status === 'changed') stats.changedRepos++
      if ((i + 1) % 25 === 0 || i === ordered.length - 1) {
        log(`进度 ${i + 1}/${ordered.length}：新拉 ${stats.filesFetched}，复用 ${stats.filesReused}`)
      }
    } catch (error) {
      stats.reposFailed++
      warn(`${target.repo} 同步异常：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 3) 按 id 合并（baseline = 上次产出的 id 集合，用于区分「真正新增」与「首次建立基线」）
  const previousData = readJson(DATA_FILE)
  const baseline = new Set((previousData?.skills ?? []).map(s => String(s.id)))
  const merged = mergeBySkillId(ordered, perRepoFiles, perRepoRefs, baseline, aiCache)
  let skills = [...merged.values()]
  if (skills.length > CONFIG.maxSkills) {
    warn(`合并结果 ${skills.length} 条超过总量上限 ${CONFIG.maxSkills}，按 star 顺序截断`)
    skills = skills.slice(0, CONFIG.maxSkills)
  }

  log(`合并完成：共 ${skills.length} 个 skill（新增 ${stats.added} / 覆盖更新 ${stats.updated}），来自 ${perRepoFiles.size} 个仓库`)

  if (DRY_RUN) {
    log('--dry-run：跳过写出')
  } else {
    writeJsonAtomic(DATA_FILE, {
      version: 1,
      syncedAt: new Date().toISOString(),
      count: skills.length,
      repos: perRepoFiles.size,
      skills,
    })
    log(`已写出 ${path.relative(ROOT, DATA_FILE)}（${(fs.statSync(DATA_FILE).size / 1e6).toFixed(1)} MB）`)
  }

  const elapsed = ((Date.now() - stats.started) / 1000).toFixed(1)
  console.log('----------------------------------------')
  console.log(`同步耗时    : ${elapsed}s`)
  console.log(`发现仓库    : ${stats.discovered || targets.length}（新 ${stats.newRepos}）`)
  console.log(`仓库状态    : 变更 ${stats.changedRepos} / 未变 ${stats.unchangedRepos} / 失败 ${stats.reposFailed}`)
  console.log(`文件拉取    : 新拉 ${stats.filesFetched} / 复用 ${stats.filesReused}`)
  console.log(`Skill 变更  : 新增 ${stats.added} / 覆盖 ${stats.updated} / 沿用 ${stats.reused} / 跨仓冲突 ${stats.collisions}`)
  if (stats.rateLimited) console.log('提示        : 本次触发 API 限流，未变更仓库均使用本地缓存（建议配置 GITHUB_TOKEN）')
  console.log('----------------------------------------')

  // 限流不算失败（数据完整，只是部分仓库未刷新）；仅在完全没有产出时判定失败
  if (skills.length === 0 && !DRY_RUN) {
    console.error('[sync] 未产出任何 skill，判定为失败')
    process.exit(1)
  }
}

main().catch(error => {
  console.error('[sync] 失败：', error)
  process.exit(1)
})
