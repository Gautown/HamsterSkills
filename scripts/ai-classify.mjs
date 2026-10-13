#!/usr/bin/env node
/**
 * AI 分类：为聚合进来的 skill 调用 LLM 判定分类，结果写入记忆库。
 *
 * 用法：
 *   npm run build                  # 先构建：loader 会在结束时写出技能清单
 *   node scripts/ai-classify.mjs   # 再运行本脚本，判定清单里未记忆化的条目
 *   node scripts/ai-classify.mjs --dry-run     # 只统计将要调用多少请求，不实际调用
 *   node scripts/ai-classify.mjs --limit 50    # 本次最多处理 50 条（调试/试水）
 *   node scripts/ai-classify.mjs --concurrency 5
 *   node scripts/ai-classify.mjs --rate-retries 8   # 加大限流重试次数（默认 5）
 *   node scripts/ai-classify.mjs --status      # 打印记忆库统计，不调用 API
 *
 * 环境变量：
 *   AI_API_BASE  默认 https://api.agnes-ai.cn/v1
 *   AI_API_KEY   必填，否则脚本直接退出（不报错，交给规则层兜底）
 *   AI_MODEL     默认 agnes-3.0-flash
 *
 * 设计要点（这些取值均来自对该接口的实测，不是猜测）：
 *   1. **不传 response_format** —— 该模型在 json_object 模式下会忽略「输出数组」的要求，
 *      只返回单个对象，导致一批 20 条只能解析出 1 条。不传时 20/20 全部正常。
 *   2. **max_tokens 留足** —— 20 条分类实测约需 1000 tokens，设 900 会被截断成空字符串。
 *   3. **temperature 0** —— 保证同样输入得到同样输出，分类结果可复现。
 *   4. **记忆化按 skill id + 内容 sha** —— 上游没改动的 skill 永远不重复付费。
 *   5. **失败降级** —— 批量解析失败时自动拆成单条重试；仍失败则跳过该条，
 *      保留规则层结果，绝不阻塞每日同步。
 *   6. **输入来自 loader 写出的技能清单**（.cache/skills-remote/_manifest.json），
 *      而不是另行爬取的语料。清单里的 id 与记忆库的键同源，
 *      所以 AI 记下的结果一定能被下一次构建查到，不会出现「白花钱」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { classifySkill, CATEGORY_KEYS } from '../src/lib/classify.mjs'
import {
  AI_CACHE_FILE,
  SKILL_MANIFEST_FILE,
  aiCacheStats,
  loadAiCache,
  recordAiCategory,
  saveAiCache,
} from '../src/lib/ai-cache.mjs'
import { RateLimitError, createThrottle, isRateLimit, parseRetryAfter, withRateLimitRetry } from '../src/lib/rate-limit.mjs'

const ROOT = process.cwd()
const CACHE_PATH = path.join(ROOT, AI_CACHE_FILE)
/**
 * 技能清单：由 astro build 的 loader 写出，记录本次构建实际收录的
 * {id, sha, description}。id 与记忆库的键同源（见 src/lib/skill-id.mjs），
 * 所以这里拿到的条目就是站点真实使用的条目，不会多花也不会漏判。
 */
const MANIFEST_PATH = path.join(ROOT, SKILL_MANIFEST_FILE)

const CONFIG = {
  apiBase: (process.env.AI_API_BASE || 'https://api.agnes-ai.cn/v1').replace(/\/+$/, ''),
  apiKey: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || 'agnes-3.0-flash',
  batchSize: 20,
  maxTokens: 1600,
  timeoutMs: 120_000,
  retries: 2,
  /** 撞到服务商速率限制后的重试次数（每次指数退避） */
  rateLimitRetries: Number(readArg('--rate-retries') || 5),
  /** 退避上限（毫秒） */
  rateLimitMaxBackoffMs: 60_000,
}

/**
 * 全局节流器：任一批次撞到 429，所有并发 worker 一起冷却。
 * 否则每个 worker 各自退避，总并发并没有真的降下来。
 */
const throttle = createThrottle()

const args = new Set(process.argv.slice(2))
const DRY_RUN = args.has('--dry-run')
const STATUS_ONLY = args.has('--status')
const LIMIT = Number(readArg('--limit') || 0)
const CONCURRENCY = Number(readArg('--concurrency') || 3)

function readArg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 ? process.argv[i + 1] : undefined
}

/**
 * 读取 loader 写出的技能清单。
 * 只保留 {id, sha, description} 三项，损坏条目直接丢弃——
 * 清单缺失不该让整轮分类失败，规则层结果照常生效。
 *
 * @returns {Array<{id: string, sha: string, description: string}>}
 */
function readManifestSkills() {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  } catch (error) {
    console.warn(`技能清单解析失败：${error.message}`)
    return []
  }
  if (!parsed || !Array.isArray(parsed.skills)) {
    console.warn('技能清单格式异常（缺少 skills 数组），跳过 AI 分类')
    return []
  }
  const out = []
  for (const item of parsed.skills) {
    if (!item || typeof item.id !== 'string' || typeof item.sha !== 'string') continue
    out.push({
      id: item.id,
      sha: item.sha,
      description: typeof item.description === 'string' ? item.description : '',
    })
  }
  return out
}

const stats = {
  started: Date.now(),
  total: 0,
  fromCache: 0,
  toClassify: 0,
  done: 0,
  failed: 0,
  requests: 0,
  tokens: 0,
  changed: 0,
}

function log(msg) {
  console.log(`[ai +${((Date.now() - stats.started) / 1000).toFixed(1)}s] ${msg}`)
}

/* ------------------------------ AI 客户端 ------------------------------ */

const SYSTEM_PROMPT = `你是 skill 分类器。把技能归入以下 10 个分类之一：
${CATEGORY_KEYS.join(', ')}

规则：
- 只依据技能的功能判断，不要依据它使用了什么技术实现
- 只输出 JSON 数组，不要任何解释文字
- 格式：[{"i":序号,"category":"分类"}]`

/**
 * 调用一次分类接口
 * @param {Array<{i:number,name:string,desc:string}>} items
 * @returns {Promise<{map: Record<number,string>, tokens: number}>}
 */
async function classifyBatch(items) {
  const lines = items
    .map(it => `${it.i}. ${it.name} — ${String(it.desc).slice(0, 200).replace(/\s+/g, ' ')}`)
    .join('\n')

  const res = await fetch(`${CONFIG.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
    body: JSON.stringify({
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `给以下 ${items.length} 个技能分类：\n${lines}` },
      ],
    }),
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // 429 单独识别：退避策略与「拆单条重试」策略都不同，见 RateLimitError 说明
    if (res.status === 429) {
      throw new RateLimitError(parseRetryAfter(res.headers.get('retry-after')), res.status)
    }
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = await res.json()
  const finish = json?.choices?.[0]?.finish_reason
  const content = json?.choices?.[0]?.message?.content || ''
  const tokens = json?.usage?.total_tokens ?? 0

  if (finish === 'length') throw new Error('输出被 max_tokens 截断（考虑调小批次或调大 max_tokens）')
  if (!content.trim()) throw new Error('模型返回空内容')

  return { map: parseCategoryMap(content, items.length), tokens }
}

/**
 * 解析模型返回的 JSON 数组，容错处理 ```json 包裹与前后杂句
 * @param {string} content
 * @param {number} expected
 */
function parseCategoryMap(content, expected) {
  let text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) throw new Error(`未找到 JSON 数组: ${text.slice(0, 120)}`)
  text = text.slice(start, end + 1)

  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('解析结果不是数组')

  /** @type {Record<number,string>} */
  const map = {}
  let valid = 0
  for (const item of parsed) {
    if (!item || typeof item.i !== 'number') continue
    const cat = typeof item.category === 'string' ? item.category.trim() : ''
    if (!CATEGORY_KEYS.includes(cat)) continue
    map[item.i] = cat
    valid++
  }
  // 一条都没解析出来视为失败，交给调用方降级处理
  if (valid === 0) throw new Error(`全部 ${parsed.length} 条分类均非法`)
  if (valid < expected) {
    // 部分成功也算成功，缺失的条目由调用方退回规则层
    console.warn(`  ⚠ 仅解析出 ${valid}/${expected} 条，缺失条目将保留规则层结果`)
  }
  return map
}

/* ------------------------------ 主流程 ------------------------------ */

async function classifyWithFallback(item) {
  // 批量优先；批量失败时自动降级为单条重试（最多两轮）
  for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
    await throttle.waitIfCooling()
    try {
      const { map, tokens } = await classifyBatch([{ ...item, i: 0 }])
      stats.requests++
      stats.tokens += tokens
      const cat = map[0]
      if (cat) return cat
    } catch (error) {
      // 限流时不再徒劳重试：交给下一批次/下一次运行
      if (isRateLimit(error)) return undefined
      if (attempt === CONFIG.retries) {
        console.warn(`  ⚠ ${item.name} 分类失败：${error.message}`)
        return undefined
      }
      await sleep(800 * (attempt + 1))
    }
  }
  return undefined
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带节流与退避的批量调用。
 *
 * 撞到速率限制时**不拆单条、不放弃**，而是退避后重试同一个批次
 * （5s → 10s → 20s → 40s → 60s 封顶，并采纳服务端 Retry-After）。
 * 这样既不放大请求量，也真正把并发压下来了。
 *
 * 非限流错误直接抛出，交由调用方决定是否降级单条。
 */
function classifyBatchThrottled(items) {
  return withRateLimitRetry(() => classifyBatch(items), {
    throttle,
    retries: CONFIG.rateLimitRetries,
    maxBackoffMs: CONFIG.rateLimitMaxBackoffMs,
    onBackoff(delay, attempt) {
      console.warn(`  速率限制，全局冷却 ${Math.round(delay / 1000)}s 后重试（剩余 ${CONFIG.rateLimitRetries - attempt} 次机会）`)
    },
  })
}

/** 固定并发度执行 */
async function mapConcurrent(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      try {
        await worker(item)
      } catch {
        /* 单项失败不影响整体 */
      }
    }
  })
  await Promise.all(runners)
}

async function main() {
  const cache = loadAiCache(CACHE_PATH)

  if (STATUS_ONLY) {
    const s = aiCacheStats(cache)
    console.log(`记忆库: ${path.relative(ROOT, CACHE_PATH)}`)
    console.log(`已记录: ${s.total} 条 | 累计 tokens: ${s.tokens} | 最近分类: ${s.lastAt || '—'}`)
    console.log('分类分布:')
    for (const [k, v] of Object.entries(s.distribution).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(11)} ${v}`)
    }
    return
  }

  if (!CONFIG.apiKey) {
    console.warn('未配置 AI_API_KEY，跳过 AI 分类（规则层结果照常生效）')
    return
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.warn(
      `未找到 ${path.relative(ROOT, MANIFEST_PATH)}，请先运行 npm run build（loader 会在构建结束时写出清单）`,
    )
    return
  }

  const skills = readManifestSkills()
  if (skills.length === 0) {
    console.warn('技能清单为空（远端聚合可能全部命中缓存或被上限截断），跳过 AI 分类')
    return
  }
  stats.total = skills.length

  // 只处理记忆库里没有「同 sha 记录」的条目
  const pending = []
  for (const s of skills) {
    const hit = cache.entries[s.id]
    if (hit && hit.sha === s.sha) stats.fromCache++
    else pending.push(s)
  }
  stats.toClassify = LIMIT > 0 ? Math.min(pending.length, LIMIT) : pending.length

  log(`总计 ${stats.total} 条 | 已记忆化 ${stats.fromCache} 条 | 待分类 ${stats.toClassify} 条`)
  log(`模型 ${CONFIG.model} | 批次 ${CONFIG.batchSize} 条 | 并发 ${CONCURRENCY}`)

  if (stats.toClassify === 0) {
    log('无需调用 API，全部条目已有记忆化结果')
    return
  }

  if (DRY_RUN) {
    const batches = Math.ceil(stats.toClassify / CONFIG.batchSize)
    log(`--dry-run：将发起约 ${batches} 个请求，不实际调用`)
    log('前 5 条待分类:')
    for (const s of pending.slice(0, 5)) log(`  ${s.id}`)
    return
  }

  const targets = pending.slice(0, stats.toClassify)
  const batches = []
  for (let i = 0; i < targets.length; i += CONFIG.batchSize) {
    batches.push(targets.slice(i, i + CONFIG.batchSize))
  }

  let doneBatches = 0
  await mapConcurrent(batches, CONCURRENCY, async (batch) => {
    const items = batch.map((s, idx) => ({
      i: idx,
      name: s.id,
      desc: s.description || s.id,
    }))

    let map = {}
    let tokens = 0
    try {
      const r = await classifyBatchThrottled(items)
      map = r.map
      tokens = r.tokens
      stats.requests++
      stats.tokens += tokens
    } catch (error) {
      if (isRateLimit(error)) {
        /*
         * 退避用尽仍被限流：放弃这批，但**不要**降级单条。
         * 单条重试会把 20 条变成 20 个请求，在限流期间无异于火上浇油。
         * 这些条目下次运行会继续处理（记忆库按 id+sha，未成功的不会留下记录）。
         */
        stats.failed += batch.length
        console.warn(`  退避后仍被限流，跳过本批 ${batch.length} 条（下次运行继续）`)
      } else {
        // 解析失败等普通错误：拆成单条重试，尽量不丢条目
        console.warn(`  批次失败（${error.message}），降级为单条重试 ${batch.length} 条`)
        for (const item of items) {
          const cat = await classifyWithFallback(item)
          if (cat) map[item.i] = cat
        }
      }
    }

    // 写回记忆库：只有内容没变的才记，避免覆盖更新版本
    for (const item of items) {
      const s = batch[item.i]
      const cat = map[item.i]
      if (!cat) {
        stats.failed++
        continue
      }
      recordAiCategory(cache, s.id, s.sha, cat, tokens ? Math.round(tokens / items.length) : undefined)
      if (s.data?.category !== cat) stats.changed++
      stats.done++
    }

    doneBatches++
    if (doneBatches % 5 === 0 || doneBatches === batches.length) {
      log(`进度 ${doneBatches}/${batches.length} 批：已分类 ${stats.done} 条（失败 ${stats.failed}）`)
      // 每 10 批落一次盘，长任务中断也不至于全丢
      if (doneBatches % 10 === 0) saveAiCache(cache, CACHE_PATH)
    }
  })

  saveAiCache(cache, CACHE_PATH)

  const elapsed = ((Date.now() - stats.started) / 1000).toFixed(1)
  console.log('----------------------------------------')
  console.log(`耗时        : ${elapsed}s`)
  console.log(`总条目      : ${stats.total}（已记忆化 ${stats.fromCache}）`)
  console.log(`本次分类    : 成功 ${stats.done} / 失败 ${stats.failed}`)
  console.log(`分类发生变化: ${stats.changed} 条`)
  console.log(`API 请求    : ${stats.requests} 个，消耗 ${stats.tokens} tokens`)
  console.log(`记忆库      : ${path.relative(ROOT, CACHE_PATH)}（共 ${Object.keys(cache.entries).length} 条）`)
  console.log('----------------------------------------')

  // 全部失败才算失败；部分失败保留规则结果即可继续
  if (stats.done === 0 && stats.toClassify > 0) {
    console.error('[ai] 全部条目分类失败，保留规则层结果')
    process.exit(1)
  }
}

main().catch(error => {
  console.error('[ai] 失败：', error)
  process.exit(1)
})