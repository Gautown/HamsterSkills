/**
 * AI 分类记忆库：记录 LLM 对每个 skill 的分类结果。
 *
 * 为什么需要它：
 *   站点页面由 astro build 通过 loader 产出，分类发生在构建期的 mapSkillData 里。
 *   所以结果必须落在这个「构建时就会读到」的位置；若只写进别处（曾经的
 *   data/skills.json），站点根本看不到。
 *   把结果落到 .cache/ai-classify.json 后，loader 在分类时优先查这里，
 *   一次 AI 分类，构建当次即生效，无需改动站点任何代码。
 *
 *   注意：id 是唯一键，sha 只是版本标记。同一个 id 被不同仓库提供时，
 *   后写入的会覆盖先写入的——loader 侧用 store.has(id) 先到先得，
 *   所以喂给本记忆库的清单必须与 loader 的收录结果完全一致
 *   （见 SKILL_MANIFEST_FILE 与 src/lib/skill-id.mjs）。
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
 * 质量判定 prompt 的版本号。
 *
 * 记忆条目的 `p` 字段记录它由哪一版 prompt 产出。判定口径调整时**必须**递增：
 * 旧条目会被视为「未筛查」，由 ai-classify 自动重新判定（一次性重跑成本），
 * loader 侧也只认当前版本的判定结果 —— 否则改了口径的判定永远不生效。
 */
export const AI_PROMPT_VERSION = 2

/**
 * 技能清单文件相对项目根的路径。
 *
 * 由 astro build 的 loader 写出（loader 是「本次构建收录了哪些技能、
 * 每个技能的 id 与内容 sha」的唯一权威），由 scripts/ai-classify.mjs 读取。
 * 清单里的 id 与记忆库的键是同一套推导（见 skill-id.mjs），
 * 所以 AI 记下来的结果一定能被下一次构建查到。
 */
export const SKILL_MANIFEST_FILE = '.cache/skills-remote/_manifest.json'

/**
 * @typedef {Object} AiEntry
 * @property {string} sha       skill 内容 sha（内容不变则不重复调用）
 * @property {CategoryKey} category
 * @property {'keep'|'drop'} [quality] AI 质量判定（缺省 = 尚未筛查）
 * @property {string} [why]     判定为 drop 时的短理由（人工复核用）
 * @property {number} [p]       产出该结果的 prompt 版本（见 AI_PROMPT_VERSION）
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
 * 查询某个 skill 的历史质量判定。
 *
 * 三道校验（任一不满足视为「未判定」，loader 侧默认放行）：
 *   sha 一致（内容没变）、prompt 版本一致（口径没变）、quality 字段存在。
 * promptVersion 传 undefined 时跳过版本校验（仅测试/特殊场景用）。
 *
 * @param {AiCacheFile | undefined} cache
 * @param {string} skillId
 * @param {string} sha 内容 sha
 * @param {number} [promptVersion] 当前 prompt 版本（见 AI_PROMPT_VERSION）
 * @returns {{quality: 'keep'|'drop', why: string} | undefined}
 */
export function lookupAiQuality(cache, skillId, sha, promptVersion) {
  if (!cache || !cache.entries) return undefined
  const hit = cache.entries[skillId]
  if (!hit || typeof hit !== 'object' || hit.sha !== sha) return undefined
  if (typeof promptVersion === 'number' && hit.p !== promptVersion) return undefined
  if (hit.quality !== 'keep' && hit.quality !== 'drop') return undefined
  return { quality: hit.quality, why: typeof hit.why === 'string' ? hit.why : '' }
}

/**
 * 该条目是否已完成当前版本的 AI 判定（分类 + 质量）。
 *
 * ai-classify 用它决定「跳过还是重新调用」：老条目没有 quality / p
 * 字段，会被判为未完成 → 自动进入全量回填，不需要手动清库。
 *
 * @param {AiCacheFile | undefined} cache
 * @param {string} skillId
 * @param {string} sha
 * @param {number} promptVersion
 */
export function isAiFresh(cache, skillId, sha, promptVersion) {
  const hit = cache?.entries?.[skillId]
  if (!hit || typeof hit !== 'object' || hit.sha !== sha) return false
  if (hit.p !== promptVersion) return false
  if (typeof hit.category !== 'string') return false
  return hit.quality === 'keep' || hit.quality === 'drop'
}

/**
 * 写入一条 AI 结果（分类 + 质量判定）。
 *
 * @param {AiCacheFile} cache
 * @param {string} skillId
 * @param {string} sha
 * @param {{category: CategoryKey, quality?: 'keep'|'drop', why?: string, p?: number}} result
 * @param {number} [tokens]
 */
export function recordAiResult(cache, skillId, sha, result, tokens) {
  cache.entries[skillId] = {
    sha,
    category: result.category,
    ...(result.quality ? { quality: result.quality } : {}),
    ...(result.why ? { why: String(result.why).slice(0, 160) } : {}),
    ...(typeof result.p === 'number' ? { p: result.p } : {}),
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
  const quality = { keep: 0, drop: 0, unscreened: 0 }
  for (const e of entries) {
    dist[e.category] = (dist[e.category] ?? 0) + 1
    if (e.quality === 'keep') quality.keep++
    else if (e.quality === 'drop') quality.drop++
    else quality.unscreened++
  }
  return {
    total: entries.length,
    tokens: entries.reduce((sum, e) => sum + (e.tokens ?? 0), 0),
    lastAt: entries.reduce((max, e) => (e.at > max ? e.at : max), ''),
    distribution: dist,
    quality,
  }
}