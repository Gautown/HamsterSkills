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
 * 双重限额（防止公开端点被刷）：
 *   1. 每 IP 每分钟 CHAT_RATE_LIMIT 条（isolate 内内存计数，best-effort）
 *   2. 全站每天 CHAT_DAILY_LIMIT 条（KV 计数器，按 UTC 日期分键）
 *   3. 单条消息与历史长度上限（直接挡住构造超长 prompt 烧 token 的尝试）
 *
 * 限额配置在 wrangler.zh.jsonc 的 vars 里，密钥走 wrangler secret put。
 */

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

/** 每 IP 频率限制窗口 */
const RATE_WINDOW_MS = 60_000
const recentHits = new Map<string, number[]>()

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
  AI_API_BASE?: string
  AI_MODEL?: string
  AI_API_KEY?: string
  CHAT_RATE_LIMIT?: string
  CHAT_DAILY_LIMIT?: string
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
- 你看不到完整的技能清单。如果用户问某个具体技能而你不能确定是否存在，就直说「站内可以搜索 XXX」，不要编造技能名或仓库地址
- 超出技能库范围的问题（写代码、闲聊、时事等），简短说明你只负责这个技能库的答疑，然后引导回技能相关问题`

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      // 允许英文站（同源，无需跨域）；这里只允许本站，避免被第三方页面盗用
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
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
 * 全站每日额度：读 → 判断 → 写。
 * KV 全局最终一致，极端并发下可能小幅超出上限，这是可接受的兜底。
 * 未绑定 KV 时退化为 isolate 内计数（更弱但不至于不可用）。
 */
const memoryDaily = new Map<string, number>()

async function consumeDailyQuota(env: ChatEnv, limit: number): Promise<{ ok: boolean; used: number }> {
  const key = `chat:${dailyKey()}`
  if (!env.CHAT_QUOTA) {
    const used = (memoryDaily.get(key) ?? 0) + 1
    memoryDaily.set(key, used)
    return { ok: used <= limit, used }
  }
  try {
    const current = Number((await env.CHAT_QUOTA.get(key)) ?? 0)
    if (current >= limit) return { ok: false, used: current }
    await env.CHAT_QUOTA.put(key, String(current + 1), { expirationTtl: 60 * 60 * 48 })
    return { ok: true, used: current + 1 }
  } catch (error) {
    // KV 故障时宁可放行也不能让聊天整体不可用；此时退化为内存计数
    console.error('[chat] KV 额度计数失败，降级为内存计数', error)
    const used = (memoryDaily.get(key) ?? 0) + 1
    memoryDaily.set(key, used)
    return { ok: used <= limit, used }
  }
}

/** 把当前技能信息拼进系统提示 */
export function buildSystemPrompt(context: ChatContext | undefined): string {
  if (!context?.title) return SYSTEM_PROMPT
  const parts = [
    `用户当前正在浏览技能详情页：`,
    `- 名称：${context.title.slice(0, 120)}`,
  ]
  if (context.category) parts.push(`- 分类：${String(context.category).slice(0, 40)}`)
  if (context.description) parts.push(`- 说明：${String(context.description).slice(0, MAX_CONTEXT_CHARS)}`)
  parts.push('', '回答时优先结合这个技能展开。')
  return `${SYSTEM_PROMPT}\n\n${parts.join('\n')}`
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
   * 先解析并校验请求体，再扣每日额度。
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

  const dailyLimit = num(env.CHAT_DAILY_LIMIT, 500)
  const quota = await consumeDailyQuota(env, dailyLimit)
  if (!quota.ok) {
    return json({ error: '今日提问额度已用完，明天再来吧' }, 429)
  }

  const apiBase = (env.AI_API_BASE || 'https://api.agnes-ai.cn/v1').replace(/\/+$/, '')
  const model = env.AI_MODEL || 'agnes-3.0-flash'

  /*
   * 到这里为止的校验都还能返回正常的 HTTP 状态码（403/405/429/400/503）。
   * 一旦开始流式响应，响应头就已发出，后续只能通过 SSE 的 error 事件告知失败。
   */
  let upstream: Response
  try {
    upstream = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        stream: true,
        messages: [
          { role: 'system', content: buildSystemPrompt(parsed.context) },
          ...parsed.messages,
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
  } catch (error) {
    console.error('[chat] 调用模型异常', error)
    return json({ error: '网络异常，请稍后重试' }, 502)
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '')
    console.error(`[chat] LLM 返回 ${upstream.status}: ${body.slice(0, 300)}`)
    return json({ error: '模型暂时不可用，请稍后重试' }, 502)
  }
  if (!upstream.body) {
    return json({ error: '模型没有返回内容，请重试' }, 502)
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
