/**
 * AI 分类记忆库：记录 LLM 对每个 skill 的分类结果。
 *
 * 为什么需要它：
 *   站点页面由 astro build 通过 loader（读 .cache/skills-remote）产出，
 *   而 AI 分类跑在 sync 之后。若只把结果写进 data/skills.json，站点根本看不到。
 *   把结果落到 .cache/ai-classify.json 后，loader 与同步脚本在分类时都会优先查这里，
 *   一次 AI 分类，站点构建与每日同步同时生效，无需改动站点任何代码。
 *
 * 记忆键是 skill id，值为该 skill 的内容 sha + 分类结果：
 *   内容没变（sha 相同）→ 复用历史结果，不重复调用 API
 *   上游改了 SKILL.md（sha 变化）→ 视为无缓存，重新判定
 *
 * 纯 Node 模块，无第三方依赖；loader（TS）与同步脚本（mjs）共用。
 */
import fs from 'node:fs'
import nodePath from 'node:path'

/** @typedef {import('./classify.mjs').CategoryKey} CategoryKey */

/** 记忆库文件相对项目根的路径 */
export const AI_CACHE_FILE = '.cache/ai-classify.json'

/**
 * @typedef {Object} AiEntry
 * @property {string} sha       skill 内容 sha（内容不变则不重复调用）
 * @property {CategoryKey} category
 * @property {string} at        分类时间（ISO）
 * @property {number} [tokens]  该次调用的 token 消耗（成本统计用）
 */

/**
 * @typedef {Object} AiCacheFile
 * @property {number} version
 * @property {Record<string, AiEntry>} entries
 * @property {Record<string, any>} [stats] 累计统计
 */

/** @returns {AiCacheFile} */
export function emptyCache() {
  return { version: 1, entries: {} }
}

/**
 * 读取记忆库；文件不存在或损坏时返回空库（不抛错，避免同步被历史脏数据卡住）
 * @param {string} filePath 绝对路径
 * @returns {AiCacheFile}
 */
export function loadAiCache(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') return emptyCache()
    return { version: 1, entries: parsed.entries, ...(parsed.stats ? { stats: parsed.stats } : {}) }
  } catch {
    return emptyCache()
  }
}

/**
 * 原子写回记忆库（先写临时文件再 rename，避免中断留下半截 JSON）
 * @param {AiCacheFile} cache
 * @param {string} filePath
 */
export function saveAiCache(cache, filePath) {
  fs.mkdirSync(nodePath.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
  fs.renameSync(tmp, filePath)
}

/**
 * 查询某个 skill 的历史分类结果
 * @param {AiCacheFile | undefined} cache
 * @param {string} skillId
 * @param {string} sha 内容 sha
 * @returns {CategoryKey | undefined} 内容未变时返回历史分类，否则 undefined
 */
export function lookupAiCategory(cache, skillId, sha) {
  if (!cache || !cache.entries) return undefined
  const hit = cache.entries[skillId]
  if (!hit || typeof hit !== 'object' || hit.sha !== sha) return undefined
  return typeof hit.category === 'string' ? hit.category : undefined
}

/**
 * 写入一条分类结果
 * @param {AiCacheFile} cache
 * @param {string} skillId
 * @param {string} sha
 * @param {CategoryKey} category
 * @param {number} [tokens]
 */
export function recordAiCategory(cache, skillId, sha, category, tokens) {
  cache.entries[skillId] = {
    sha,
    category,
    at: new Date().toISOString(),
    ...(typeof tokens === 'number' ? { tokens } : {}),
  }
}

/**
 * 记忆库统计信息（用于 --status）
 * @param {AiCacheFile} cache
 */
export function aiCacheStats(cache) {
  const entries = Object.values(cache?.entries ?? {})
  const dist = {}
  for (const e of entries) dist[e.category] = (dist[e.category] ?? 0) + 1
  return {
    total: entries.length,
    tokens: entries.reduce((sum, e) => sum + (e.tokens ?? 0), 0),
    lastAt: entries.reduce((max, e) => (e.at > max ? e.at : max), ''),
    distribution: dist,
  }
}