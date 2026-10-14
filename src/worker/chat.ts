/**
 * 聊天端点：POST /api/chat（SSE 流式）
 *
 * 为什么必须有服务端：站点是全静态的，AI_API_KEY 一旦写进前端 JS，
 * 任何人查看网页源代码就能拿走。所以浏览器只与本站 Worker 通信，
 * 由 Worker 持密钥去调 LLM。
 *
 * 响应协议（text/event-stream，每个事件一行 data: JSON）：
 *   {"type":"meta","model":…,"dailyUsed":…,"dailyLimit":…}   首帧，带额度用量
 *   {"type":"delta","text":"增量文本"}                          正文，可出现任意多次
 *   {"type":"error","message":"…"}                              流中途失败（状态码已发出）
 *   {"type":"done"}                                             正常结束
 *
 * 站内技能检索：每次提问用最后一问去匹配 skills-index.json，top-10 注入系统提示。
 * 整库塞进提示约 43k tokens，既贵又会被截断，检索是唯一可行解。
 *
 * 双重限额（防止公开端点被刷）：
 *   1. 每 IP 每分钟 CHAT_RATE_LIMIT 条（isolate 内内存计数，best-effort）
 *   2. 全站每天 CHAT_DAILY_LIMIT 条（KV 计数器，按 UTC 日期分键）
 *   3. 单条消息与历史长度上限（直接挡住构造超长 prompt 烧 token 的尝试）
 *
 * 限额配置在 wrangler.zh.jsonc 的 vars 里，密钥走 wrangler secret put。
 */
import { buildIndex, formatHits, search, toSearchable } from '../lib/search-index.mjs'
import type { SearchHit } from '../lib/search-index.mjs'

/** 单条消息最大字符数 */
const MAX_MESSAGE_CHARS = 2000
/** 一次请求允许携带的历史消息条数（含 system） */
const MAX_HISTORY = 20
/** 注入系统提示的当前技能信息长度上限 */
const MAX_CONTEXT_CHARS = 400
/**
 * 流式响应超时（墙钟）。
 * 比非流式宽裕：流式期间大部分时间在等上游推数据，不占 CPU，
 * 但仍需上限以免连接悬挂。
 */
const LLM_TIMEOUT_MS = 60_000
/** LLM 单次回复的 token 上限 */
const MAX_TOKENS = 800
/**
 * 每次注入的站内技能条数。
 * 10 条约合 1-2k tokens：足够覆盖真实需求，又不至于挤占回答空间；
 * 再多会稀释相关性，也会让模型倾向把清单全念一遍。
 */
const SEARCH_TOP_K = 10

/**
 * 上游 429 后重试一次前的等待时间（毫秒），可用 CHAT_RETRY_DELAY_MS 覆盖。
 *
 * 实测（2026-10-14，agnes-3.0-flash 免费档，从普通网络直连，并发 1）：
 *   连续请求 34 个后开始 429；限流窗口每分钟只放行 34 个请求；
 *   从触发限流到恢复约 14 秒；成功请求耗时中位 7025ms。
 *
 * 5 秒是权衡：短到用户察觉不到，长到有机会赶上配额桶回补。
 * 只重试 1 次——免费档本来就很紧，多试几次只会把桶抽得更干。
 *
 * **局限**：这条重试只对「账户配额桶见底」有效。
 * 若触发条件是出口 IP 被限流（Cloudflare Worker 的共享出口正是如此，
 * 实测同一密钥从 Worker 调用会持续 429 超过数分钟，而本机直连正常），
 * 等多久都不会好转，重试纯属浪费。两种情况返回的 429 完全一样，
 * Worker 在请求期无法区分，因此只能当作对前一种情况的兜底。
 */
const DEFAULT_RETRY_DELAY_MS = 5_000

/**
 * 上游限流时的用户提示。
 *
 * 刻意**不承诺具体恢复时间**。
 * 实测（2026-10-14）从普通网络直连上游，限流后约 14 秒恢复；
 * 但同一密钥经 Cloudflare Worker 调用会持续 429 超过数分钟 ——
 * 触发条件是**出口 IP** 被限流，不是账户配额桶，等待并不会好转。
 * 用户走的正是 Worker 这条通道，承诺「15 秒」就是骗他们反复点重试。
 */
const UPSTREAM_RATE_LIMIT_MESSAGE = '提问太频繁，服务商侧正在限流，请稍后重试'

/** 每 IP 频率限制窗口 */
const RATE_WINDOW_MS = 60_000
const recentHits = new Map<string, number[]>()

/** 等待若干毫秒。用于上游限流后的短暂退避 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 从上游错误响应体里取出服务商给的**真实原因**。
 *
 * 此前这里只把响应体打进日志，用户看到的是写死的「正在限流」——
 * 那是猜的。拿到真实原因才能判断该不该让用户等：
 * 429 未必都意味着「等一会就好」（实测有免费档配额用尽这类，
 * 文案与恢复预期完全不同）。
 *
 * 兼容三种常见形状：OpenAI 的 {error:{message}}、{error:"..."}、{message}，
 * 以及非 JSON 的纯文本错误页。
 */
export function parseUpstreamError(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const err = parsed.error
    if (typeof err === 'string') return err
    if (err && typeof err === 'object') {
      const message = (err as { message?: unknown }).message
      if (typeof message === 'string') return message
    }
    if (typeof parsed.message === 'string') return parsed.message
  } catch {
    // 非 JSON，原样返回
  }
  return trimmed.slice(0, 200)
}

/**
 * KV 绑定的最小接口。
 * 项目未安装 @cloudflare/workers-types，与 index.ts 的 Ctx 同样手写声明，
 * 避免为一个类型引入整套类型依赖。
 */
export interface KvNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/** 消息与上下文的硬上限，导出便于测试断言 */
export const LIMITS = {
  MAX_MESSAGE_CHARS,
  MAX_HISTORY,
  MAX_CONTEXT_CHARS,
  MAX_TOKENS,
} as const

export interface ChatEnv {
  /** 静态资产绑定：用于读取站内技能索引（skills-index.json） */
  ASSETS?: { fetch(request: Request): Promise<Response> }
  AI_API_BASE?: string
  AI_MODEL?: string
  AI_API_KEY?: string
  CHAT_RATE_LIMIT?: string
  CHAT_DAILY_LIMIT?: string
  /** 上游 429 后重试前的等待毫秒数，不配则用 5 秒 */
  CHAT_RETRY_DELAY_MS?: string
  CHAT_QUOTA?: KvNamespace
}

export interface ChatContext {
  /** 当前页面技能 id */
  id?: string
  title?: string
  category?: string
  description?: string
}

interface ChatRequest {
  messages: Array<{ role: string; content: string }>
  context?: ChatContext
}

const SYSTEM_PROMPT = `你是「仓鼠技能库」的助手（hamster.gautown.top）。这个站点聚合了 GitHub 上的 Agent Skills——供 Claude Code、Cursor、opencode 等 AI 编程工具加载的能力模块，每个技能有名称、用途说明、分类和来源仓库。

你的职责：
- 回答关于这个技能库的问题：有哪些技能、某个技能是干什么的、该用哪个分类
- 根据用户描述的需求推荐合适的技能，并说明推荐理由
- 解释 Agent Skills 的概念、安装与使用方式
- 如果用户在某个技能详情页提问，回答时要结合该技能本身

要求：
- 用提问者的语言回答（中文提问就中文回答，英文提问就英文回答）
- 简洁务实，不要客套话和免责声明
- 你的技能知识来自下方按问题检索出的候选清单。清单里没有的技能，你就说不知道，
  绝不要编造技能名、路径或仓库地址
- 超出技能库范围的问题（写代码、闲聊、时事等），简短说明你只负责这个技能库的答疑，然后引导回技能相关问题`

/**
 * 站内技能检索索引：按需加载一次，常驻 isolate 内存。
 * 加载失败会降级为空索引 —— 助手仍能回答，只是不再引用站内技能。
 *
 * @type {import('../lib/search-index.mjs').SearchIndex | null}
 */
let skillIndex = null
/** @type {Promise<import('../lib/search-index.mjs').SearchIndex> | null} */
let skillIndexLoading = null

/**
 * @param {ChatEnv} env
 * @param {string} origin 请求来源，用于拼索引的真实地址
 */
async function getSkillIndex(env: ChatEnv, origin: string) {
  if (skillIndex) return skillIndex
  if (skillIndexLoading) return skillIndexLoading
  if (!env.ASSETS) {
    console.warn('[chat] 无 ASSETS 绑定，跳过技能索引加载')
    skillIndex = buildIndex([])
    return skillIndex
  }

  skillIndexLoading = (async () => {
    try {
      // 必须用真实来源：ASSETS 绑定不接受虚构的 host
      const url = new URL('/skills-index.json', origin)
      const res = await env.ASSETS.fetch(new Request(url.toString()))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const items = Array.isArray(data) ? data : data?.items
      if (!Array.isArray(items) || items.length === 0) throw new Error('索引内容为空')
      const searchable = toSearchable(items)
      skillIndex = buildIndex(searchable)
      console.log(`[chat] 技能索引已加载：${searchable.length} 条`)
    } catch (error) {
      console.error('[chat] 技能索引加载失败，助手本次不引用站内技能 —', message(error))
      skillIndex = buildIndex([])
    } finally {
      skillIndexLoading = null
    }
    return skillIndex
  })()

  return skillIndexLoading
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // 与静态资产的 _headers 保持一致的最小安全集。
      // 聊天端点不应被任何页面内嵌，也不该泄露访问来源。
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    },
  })
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** 把任意异常转成可读文案（日志用） */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** best-effort 每 IP 限流：窗口内请求数超过阈值则拒绝 */
export function rateLimited(ip: string, limit: number): boolean {
  const now = Date.now()
  const hits = (recentHits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS)
  if (hits.length >= limit) {
    recentHits.set(ip, hits)
    return true
  }
  hits.push(now)
  recentHits.set(ip, hits)
  // 防止 Map 无限增长：条目过多时整体清空（best-effort，牺牲少量精确性）
  if (recentHits.size > 5000) recentHits.clear()
  return false
}

/** UTC 日期分键，便于次日自动归零 */
export function dailyKey(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/**
 * 全站每日额度。
 *
 * 刻意拆成「只读检查」与「计数」两步，而不是「先扣后退」：
 * 调用上游可能失败（服务商限流、网络异常、5xx），这些都不该消耗用户额度。
 * 改成失败后退款的话，KV 的读-改-写在并发下会丢更新（后写覆盖先写），
 * 退款反而可能把计数弄错；先读后写就没有这个问题。
 *
 * KV 全局最终一致，peek 与 commit 之间有并发窗口，极端情况可能小幅超出上限，
 * 这是可接受的兜底。未绑定 KV 时退化为 isolate 内计数（更弱但不至于不可用）。
 */
const memoryDaily = new Map<string, number>()

function dailyCounterKey(): string {
  return `chat:${dailyKey()}`
}

/**
 * 只读当前用量，不写入。
 * KV 读取失败时放行：计数器是辅助设施，不该让它把聊天整体拖垮。
 */
async function peekDailyQuota(env: ChatEnv, limit: number): Promise<{ ok: boolean; used: number }> {
  const key = dailyCounterKey()
  if (!env.CHAT_QUOTA) {
    const used = memoryDaily.get(key) ?? 0
    return { ok: used < limit, used }
  }
  try {
    const used = Number((await env.CHAT_QUOTA.get(key)) ?? 0)
    return { ok: used < limit, used }
  } catch (error) {
    console.error('[chat] KV 额度读取失败，按放行处理', error)
    return { ok: true, used: 0 }
  }
}

/**
 * 计数 +1。只在确认要服务这次请求之后调用，
 * 因此服务商限流与网络异常都不会消耗用户的每日额度。
 */
async function commitDailyQuota(env: ChatEnv, limit: number): Promise<{ ok: boolean; used: number }> {
  const key = dailyCounterKey()
  if (!env.CHAT_QUOTA) {
    const used = (memoryDaily.get(key) ?? 0) + 1
    memoryDaily.set(key, used)
    return { ok: used <= limit, used }
  }
  try {
    const current = Number((await env.CHAT_QUOTA.get(key)) ?? 0)
    const used = current + 1
    await env.CHAT_QUOTA.put(key, String(used), { expirationTtl: 60 * 60 * 48 })
    return { ok: used <= limit, used }
  } catch (error) {
    // KV 故障时降级为内存计数，至少在本 isolate 内仍然有效
    console.error('[chat] KV 额度计数失败，降级为内存计数', error)
    const used = (memoryDaily.get(key) ?? 0) + 1
    memoryDaily.set(key, used)
    return { ok: used <= limit, used }
  }
}

/**
 * 把检索到的站内技能与当前页面上下文合并成系统提示。
 *
 * 两者都可选，缺任一都不影响另一个。有检索结果时优先级更高——
 * 用户提问才是真实意图，页面上下文只是「他正在看这条」的补充。
 */
export function buildSystemPrompt(context: ChatContext | undefined, hits: SearchHit[] = []): string {
  const parts: string[] = []

  const found = formatHits(hits)
  if (found) {
    parts.push(
      found,
      '',
      '以上是按用户提问的关键词从站内检索出的**部分**相关技能，不是完整清单' +
        '（站内实际有八千多个）。规则：',
      '1. 引用技能时只能用上面出现过的名称与路径（/skills/<id>/），不要编造任何其它技能',
      '2. 如果上面都不合适，就说「这几个不太合适，建议直接在站内搜索 <关键词>」，不要勉强推荐',
    )
  }

  if (context?.title) {
    const ctx: string[] = ['用户当前正在浏览技能详情页：', `- 名称：${context.title.slice(0, 120)}`]
    if (context.category) ctx.push(`- 分类：${String(context.category).slice(0, 40)}`)
    if (context.description) ctx.push(`- 说明：${String(context.description).slice(0, MAX_CONTEXT_CHARS)}`)
    ctx.push('', '回答时优先结合这个技能展开。')
    parts.push(ctx.join('\n'))
  }

  if (parts.length === 0) return SYSTEM_PROMPT
  return `${SYSTEM_PROMPT}\n\n${parts.join('\n\n')}`
}

/** 校验并裁剪请求体 */
export function normalize(input: unknown): ChatRequest | { error: string } {
  if (!input || typeof input !== 'object') return { error: '请求体格式错误' }
  const body = input as Record<string, unknown>
  const raw = body.messages
  if (!Array.isArray(raw) || raw.length === 0) return { error: '缺少 messages' }
  if (raw.length > MAX_HISTORY) return { error: `历史消息过多（最多 ${MAX_HISTORY} 条）` }

  const messages: Array<{ role: string; content: string }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return { error: '消息格式错误' }
    const m = item as Record<string, unknown>
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const content = typeof m.content === 'string' ? m.content.trim() : ''
    if (!content) return { error: '消息内容为空' }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { error: `单条消息过长（最多 ${MAX_MESSAGE_CHARS} 字）` }
    }
    messages.push({ role, content })
  }
  if (messages[0].role !== 'user') return { error: '首条消息必须是 user' }

  const ctx = body.context as Record<string, unknown> | undefined
  const context: ChatContext | undefined =
    ctx && typeof ctx === 'object'
      ? {
          id: typeof ctx.id === 'string' ? ctx.id.slice(0, 120) : undefined,
          title: typeof ctx.title === 'string' ? ctx.title.slice(0, 200) : undefined,
          category: typeof ctx.category === 'string' ? ctx.category.slice(0, 40) : undefined,
          description: typeof ctx.description === 'string' ? ctx.description.slice(0, 600) : undefined,
        }
      : undefined

  return { messages, context }
}

export async function handleChat(request: Request, env: ChatEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: '仅支持 POST' }, 405)
  if (!env.AI_API_KEY) return json({ error: '聊天功能尚未配置' }, 503)

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const rateLimit = num(env.CHAT_RATE_LIMIT, 3)
  if (rateLimited(ip, rateLimit)) {
    return json({ error: '发送太快了，请稍等一下再试' }, 429)
  }

  /*
   * 先解析并校验请求体，再看每日额度。
   * 顺序很重要：畸形请求（坏 JSON、空内容、超长）根本不会调用模型，
   * 不该占用全站额度——否则一个坏客户端或探测程序就能用垃圾请求
   * 把当天的额度耗光。每 IP 限流已经挡住了这类洪泛。
   */
  let input: unknown
  try {
    input = await request.json()
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400)
  }

  const parsed = normalize(input)
  if ('error' in parsed) return json({ error: parsed.error }, 400)

  const dailyLimit = num(env.CHAT_DAILY_LIMIT, 200)
  /*
   * 先只读挡一道，超额的请求不必白占服务商那点免费额度。
   * 计数留到确认要服务之后（见下方 commitDailyQuota 的调用点）。
   */
  const peeked = await peekDailyQuota(env, dailyLimit)
  if (!peeked.ok) {
    return json({ error: '今日提问额度已用完，明天再来吧' }, 429)
  }

  const apiBase = (env.AI_API_BASE || 'https://api.agnes-ai.cn/v1').replace(/\/+$/, '')
  const model = env.AI_MODEL || 'agnes-3.0-flash'

  /*
   * 检索站内技能：用用户最后一问去匹配，top-K 注入系统提示。
   * 只取最后一问而非整段对话——多轮里最近一句通常才是当前意图，
   * 整段拼起来会把旧话题的词带进来污染检索。
   */
  const lastQuestion = parsed.messages.at(-1)?.content ?? ''
  let hits: SearchHit[] = []
  try {
    const index = await getSkillIndex(env, new URL(request.url).origin)
    hits = search(index, lastQuestion, SEARCH_TOP_K)
    console.log(`[chat] 检索「${lastQuestion.slice(0, 40)}」→ ${hits.length} 条`)
    if (hits.length > 0) console.log(`[chat] 命中：${hits.map(h => h.id).join(', ')}`)
  } catch (error) {
    // 检索失败不能影响对话，降级为「本次不提供站内依据」
    console.error('[chat] 技能检索失败，本次不注入站内依据 —', message(error))
  }

  /*
   * 到这里为止的校验都还能返回正常的 HTTP 状态码（403/405/429/400/503）。
   * 一旦开始流式响应，响应头就已发出，后续只能通过 SSE 的 error 事件告知失败。
   */
  let upstream: Response | null = null
  let rateLimitBody = ''
  let rateLimitStatus = 0
  let networkError: unknown = null

  /*
   * 整个调用共用一个超时预算（含重试等待），
   * 避免两次尝试各拿 60 秒把请求拖成两分钟。
   */
  const deadline = AbortSignal.timeout(LLM_TIMEOUT_MS)
  const retryDelay = num(env.CHAT_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS)

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      console.log(`[chat] 上游限流，等待 ${retryDelay}ms 后重试`)
      await sleep(retryDelay)
    }
    let res: Response
    try {
      res = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          temperature: 0.3,
          stream: true,
          messages: [
            { role: 'system', content: buildSystemPrompt(parsed.context, hits) },
            ...parsed.messages,
          ],
        }),
        signal: deadline,
      })
    } catch (error) {
      /*
       * 网络异常不重试：等几秒多半还是连不上，
       * 而且失败的原因（DNS、超时、连接被拒）不是重试能解决的。
       */
      networkError = error
      break
    }
    if (res.status !== 429) {
      upstream = res
      break
    }
    rateLimitStatus = res.status
    // 读掉响应体再重试，否则连接挂住不放
    rateLimitBody = await res.text().catch(() => '')
  }

  if (networkError) {
    console.error('[chat] 调用模型异常', networkError)
    return json({ error: '网络异常，请稍后重试' }, 502)
  }

  /*
   * 重试后仍是 429：上游侧的速率/配额限制（免费档尤其常见），与本站限额无关。
   * 用服务商自己给的原因来记录，而不是只看状态码——否则无从判断
   * 「等 15 秒会好」还是「这个原因永远不会好」。
   */
  if (!upstream) {
    const reason = parseUpstreamError(rateLimitBody)
    console.error(`[chat] LLM 返回 ${rateLimitStatus}（已重试 1 次仍限流）: ${reason}`)
    return json({ error: UPSTREAM_RATE_LIMIT_MESSAGE }, 429)
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '')
    console.error(`[chat] LLM 返回 ${upstream.status}: ${parseUpstreamError(body)}`)
    // 上游 5xx 属于服务商故障，值得让用户重试
    return json({ error: upstream.status >= 500 ? '模型服务暂时不可用，请稍后重试' : '模型请求被拒绝，请稍后重试' }, 502)
  }
  if (!upstream.body) {
    return json({ error: '模型没有返回内容，请重试' }, 502)
  }

  /*
   * 到这里确定要服务这次请求了，才计入每日额度。
   * peek 与 commit 之间的并发窗口可能让实际用量略微越界，
   * 与原先「KV 最终一致」的容忍度一致。
   */
  const quota = await commitDailyQuota(env, dailyLimit)
  if (!quota.ok) {
    console.warn(`[chat] 额度在调用期间被并发耗尽：${quota.used}/${dailyLimit}`)
  }

  return sseResponse(upstream.body, { model, dailyUsed: quota.used, dailyLimit })
}

/** 封装成一个 SSE 事件帧 */
function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 把上游的 OpenAI 兼容 SSE 重新封装成本站协议后转发。
 *
 * 不做裸管道的原因：
 *   1. 流开始后响应头已发出，无法再改 HTTP 状态码。
 *      上游中途断线只能靠 error 事件告知前端，而不是静默截断。
 *   2. 可以把额度用量作为首帧带给前端（HTTP 头此时也已发出）。
 *   3. 不把上游的 chunk 结构原样暴露给前端，后续换供应商时前端不用改。
 *
 * 上游帧格式：`data: {"choices":[{"delta":{"content":"..."}}]}`，以 `data: [DONE]` 结束。
 */
function sseResponse(
  upstream: ReadableStream<Uint8Array>,
  meta: { model: string; dailyUsed: number; dailyLimit: number },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder()
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(sseFrame(payload)))
        } catch {
          // 客户端已断开：忽略后续写入
        }
      }

      send({ type: 'meta', model: meta.model, dailyUsed: meta.dailyUsed, dailyLimit: meta.dailyLimit })

      const reader = upstream.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false

      try {
        while (!finished) {
          const { value, done } = await reader.read()
          if (done) break
          // stream: true 必须，否则多字节字符会被截断
          buffer += decoder.decode(value, { stream: true })

          // 按行切分。注意不能用 split('\n') 后丢弃残块——
          // 一个 SSE 帧可能跨多个 TCP 包到达，残块要留在 buffer 里等下一批。
          let newline = buffer.indexOf('\n')
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            newline = buffer.indexOf('\n')

            // 忽略空行、注释行（以 : 开头）与 event:/id: 等字段
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload) continue
            if (payload === '[DONE]') {
              finished = true
              break
            }

            let delta: unknown
            try {
              delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
            } catch {
              // 单帧解析失败不应中断整条流，跳过即可
              continue
            }
            // 首帧通常只带 role，content 为空串；空串不必推送
            if (typeof delta === 'string' && delta.length > 0) {
              send({ type: 'delta', text: delta })
            }
          }
        }
        send({ type: 'done' })
      } catch (error) {
        console.error('[chat] 流式传输中断', error)
        send({ type: 'error', message: '连接中断，请重试' })
      } finally {
        try {
          await reader.cancel()
        } catch {
          // 已结束
        }
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform：防止中间层缓冲，破坏流式效果
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
