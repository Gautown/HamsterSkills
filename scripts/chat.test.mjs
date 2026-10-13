/**
 * 聊天端点测试（node:test，零依赖）
 *
 * 运行：node --experimental-strip-types --test scripts/chat.test.mjs
 *
 * 重点覆盖「不配置真实密钥也能验证」的部分：
 * 入参校验、上下文裁剪、限流、额度计数、以及 handleChat 的各条错误分支。
 * LLM 调用通过替换 globalThis.fetch 模拟。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LIMITS,
  buildSystemPrompt,
  dailyKey,
  handleChat,
  normalize,
  rateLimited,
} from '../src/worker/chat.ts'

/* ------------------------------ 测试辅助 ------------------------------ */

const postRequest = (body, ip = '1.1.1.1') =>
  new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const okEnv = { AI_API_KEY: 'test-key', AI_MODEL: 'agnes-3.0-flash' }

/** 用假的 LLM 响应替换全局 fetch */
function mockFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => handler(String(input), init ?? {})
  return () => {
    globalThis.fetch = original
  }
}

/**
 * 造一个上游 SSE 响应。
 * chunks 用来模拟「一个 SSE 帧跨多个 TCP 包到达」——这是流式实现最易错的地方。
 * 字符串会按 UTF-8 编码；Uint8Array 原样透传（用于逐字节拆分的极端场景）。
 */
function llmStream(chunks) {
  const enc = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(c instanceof Uint8Array ? c : enc.encode(c))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/** 读取 SSE 响应并解析成事件数组 */
async function readEvents(res) {
  const text = await res.text()
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('data:'))
    .map(l => JSON.parse(l.slice(5).trim()))
}

/** 上游帧文本：首帧只带 role，随后逐块带 content，末帧 [DONE] */
const frame = content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
const roleFrame = `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`

/** 默认的成功上游响应：一段正常内容 + [DONE] */
const llmOk = (content = '推荐 pdf 相关技能') => llmStream([roleFrame, frame(content), 'data: [DONE]\n\n'])

/* ------------------------------ normalize ------------------------------ */

test('normalize：正常请求原样通过', () => {
  const r = normalize({ messages: [{ role: 'user', content: '你好' }] })
  assert.ok(!('error' in r))
  assert.equal(r.messages.length, 1)
  assert.equal(r.messages[0].content, '你好')
})

test('normalize：拒绝缺失或非数组的 messages', () => {
  assert.ok('error' in normalize(null))
  assert.ok('error' in normalize({}))
  assert.ok('error' in normalize({ messages: 'hi' }))
  assert.ok('error' in normalize({ messages: [] }))
})

test('normalize：拒绝超过历史上限的请求', () => {
  const many = Array.from({ length: LIMITS.MAX_HISTORY + 1 }, () => ({ role: 'user', content: 'x' }))
  const r = normalize({ messages: many })
  assert.ok('error' in r)
  assert.match(r.error, /历史消息过多/)
})

test('normalize：恰好达到历史上限可通过', () => {
  const exact = Array.from({ length: LIMITS.MAX_HISTORY }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x',
  }))
  assert.ok(!('error' in normalize({ messages: exact })))
})

test('normalize：拒绝单条超长消息（防烧 token）', () => {
  const long = 'x'.repeat(LIMITS.MAX_MESSAGE_CHARS + 1)
  const r = normalize({ messages: [{ role: 'user', content: long }] })
  assert.ok('error' in r)
  assert.match(r.error, /单条消息过长/)
})

test('normalize：拒绝空内容与空白内容', () => {
  assert.ok('error' in normalize({ messages: [{ role: 'user', content: '' }] }))
  assert.ok('error' in normalize({ messages: [{ role: 'user', content: '   \n  ' }] }))
})

test('normalize：拒绝首条非 user', () => {
  const r = normalize({
    messages: [
      { role: 'assistant', content: '你好' },
      { role: 'user', content: 'hi' },
    ],
  })
  assert.ok('error' in r)
  assert.match(r.error, /首条消息必须是 user/)
})

test('normalize：未知 role 归一为 user，assistant 保留', () => {
  const r = normalize({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'system', content: 'c' },
    ],
  })
  assert.ok(!('error' in r))
  assert.equal(r.messages[1].role, 'assistant')
  // 前端不该能注入 system 提示，统一降级为 user
  assert.equal(r.messages[2].role, 'user')
})

test('normalize：上下文各字段被裁剪到上限内', () => {
  const r = normalize({
    messages: [{ role: 'user', content: 'hi' }],
    context: {
      id: 'i'.repeat(500),
      title: 'T'.repeat(500),
      category: 'C'.repeat(200),
      description: 'D'.repeat(2000),
    },
  })
  assert.ok(!('error' in r))
  assert.equal(r.context.id.length, 120)
  assert.equal(r.context.title.length, 200)
  assert.equal(r.context.category.length, 40)
  assert.equal(r.context.description.length, 600)
})

test('normalize：context 类型错误时忽略而非报错', () => {
  const r = normalize({ messages: [{ role: 'user', content: 'hi' }], context: '不是对象' })
  assert.ok(!('error' in r))
  assert.equal(r.context, undefined)
})

/* --------------------------- buildSystemPrompt --------------------------- */

test('buildSystemPrompt：无上下文时返回基础提示', () => {
  assert.equal(buildSystemPrompt(undefined), buildSystemPrompt({}))
  assert.match(buildSystemPrompt(undefined), /仓鼠技能库/)
})

test('buildSystemPrompt：有上下文时注入技能信息', () => {
  const p = buildSystemPrompt({ title: 'PDF 处理', category: 'office', description: '合并与拆分 PDF' })
  assert.match(p, /PDF 处理/)
  assert.match(p, /office/)
  assert.match(p, /合并与拆分 PDF/)
  assert.match(p, /优先结合这个技能/)
})

test('buildSystemPrompt：超长字段被裁剪', () => {
  const p = buildSystemPrompt({ title: 'T'.repeat(500), description: 'D'.repeat(2000) })
  assert.ok(!p.includes('T'.repeat(121)))
  assert.ok(!p.includes('D'.repeat(LIMITS.MAX_CONTEXT_CHARS + 1)))
})

test('buildSystemPrompt：始终保留「不要编造」的约束', () => {
  // 上下文再长也不能把这条核心约束挤掉（它是拼接在基础提示之后，不会丢）
  const p = buildSystemPrompt({ title: 'x', description: 'y'.repeat(5000) })
  assert.match(p, /不要编造技能名/)
})

/* ------------------------------ rateLimited ------------------------------ */

test('rateLimited：窗口内超过阈值则拒绝', () => {
  const ip = `10.0.0.${Math.floor(Math.random() * 250)}`
  assert.equal(rateLimited(ip, 3), false)
  assert.equal(rateLimited(ip, 3), false)
  assert.equal(rateLimited(ip, 3), false)
  assert.equal(rateLimited(ip, 3), true)
  assert.equal(rateLimited(ip, 3), true)
})

test('rateLimited：不同 IP 互不影响', () => {
  const a = `10.1.0.${Math.floor(Math.random() * 250)}`
  const b = `10.2.0.${Math.floor(Math.random() * 250)}`
  for (let i = 0; i < 5; i++) rateLimited(a, 3)
  assert.equal(rateLimited(b, 3), false)
})

/* ------------------------------- dailyKey ------------------------------- */

test('dailyKey：按 UTC 日期分键，格式 YYYY-MM-DD', () => {
  assert.match(dailyKey(), /^\d{4}-\d{2}-\d{2}$/)
  // 次日自动换键，实现「每日额度归零」
  assert.notEqual(dailyKey(new Date('2026-10-13T00:00:00Z')), dailyKey(new Date('2026-10-12T23:59:59Z')))
  assert.equal(dailyKey(new Date('2026-10-13T23:59:59Z')), dailyKey(new Date('2026-10-13T00:00:01Z')))
})

/* ------------------------------ handleChat ------------------------------ */

test('handleChat：GET 返回 405', async () => {
  const res = await handleChat(new Request('https://x/api/chat'), okEnv)
  assert.equal(res.status, 405)
})

test('handleChat：未配置 AI_API_KEY 返回 503', async () => {
  const res = await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }), {})
  assert.equal(res.status, 503)
  assert.match((await res.json()).error, /尚未配置/)
})

test('handleChat：非法 JSON 返回 400', async () => {
  const restore = mockFetch(() => llmOk())
  try {
    const res = await handleChat(postRequest('{ 不是 JSON', '2.2.2.2'), okEnv)
    assert.equal(res.status, 400)
  } finally {
    restore()
  }
})

test('handleChat：入参校验失败返回 400', async () => {
  const restore = mockFetch(() => llmOk())
  try {
    const res = await handleChat(postRequest({ messages: [] }, '2.2.2.3'), okEnv)
    assert.equal(res.status, 400)
  } finally {
    restore()
  }
})

test('handleChat：超过每 IP 限流返回 429', async () => {
  const restore = mockFetch(() => llmOk())
  const ip = '3.3.3.3'
  try {
    const codes = []
    for (let i = 0; i < 5; i++) {
      const res = await handleChat(postRequest({ messages: [{ role: 'user', content: `q${i}` }] }, ip), { ...okEnv, CHAT_RATE_LIMIT: '2' })
      codes.push(res.status)
    }
    assert.ok(codes.includes(429), `期望出现 429，实际 ${codes.join(',')}`)
  } finally {
    restore()
  }
})

test('handleChat：超过每日额度返回 429', async () => {
  const restore = mockFetch(() => llmOk())
  const kv = makeKv() // 计数器必须跨请求共用同一个，才能验证额度累加
  try {
    const codes = []
    for (let i = 0; i < 4; i++) {
      const res = await handleChat(
        postRequest({ messages: [{ role: 'user', content: `q${i}` }] }, `4.4.4.${i + 1}`),
        // 独立 KV，避免受其他测试的内存计数影响
        { ...okEnv, CHAT_QUOTA: kv, CHAT_DAILY_LIMIT: '2', CHAT_RATE_LIMIT: '10' },
      )
      codes.push(res.status)
    }
    assert.deepEqual(codes, [200, 200, 429, 429], '前两次放行，之后应被每日额度拦住')
  } finally {
    restore()
  }
})

/** 造一个干净的 KV 替身，避免测试之间通过内存计数器互相干扰 */
function makeKv() {
  const store = new Map()
  return {
    get: async k => store.get(k) ?? null,
    put: async (k, v) => {
      store.set(k, v)
    },
    /** 仅测试用：查看内部状态 */
    dump: () => store,
  }
}

test('handleChat：正常路径返回 SSE 流并在 meta 帧带额度', async () => {
  let seenUrl = ''
  let seenBody = null
  const restore = mockFetch((url, init) => {
    seenUrl = url
    seenBody = JSON.parse(String(init.body))
    return llmStream([roleFrame, frame('推荐 '), frame('doc-coauthoring'), 'data: [DONE]\n\n'])
  })
  try {
    const res = await handleChat(
      postRequest(
        { messages: [{ role: 'user', content: '怎么写文档' }], context: { title: 'PDF 处理', category: 'office' } },
        '5.5.5.5',
      ),
      { ...okEnv, CHAT_QUOTA: makeKv() },
    )
    assert.equal(res.status, 200)
    const events = await readEvents(res)
    assert.equal(events[0].type, 'meta')
    assert.equal(events.filter(e => e.type === 'delta').map(d => d.text).join(''), '推荐 doc-coauthoring')
    assert.match(seenUrl, /\/chat\/completions$/)
    assert.match(seenBody.messages[0].content, /PDF 处理/)
    assert.equal(seenBody.messages[0].role, 'system')
    assert.equal(JSON.stringify(seenBody).includes('test-key'), false)
  } finally {
    restore()
  }
})

test('handleChat：上游无 body 时返回 502', async () => {
  const restore = mockFetch(() => new Response(null, { status: 200 }))
  try {
    const res = await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '6.6.7.7'), okEnv)
    assert.equal(res.status, 502)
  } finally {
    restore()
  }
})

/* ------------------------------ 流式（SSE）------------------------------ */

test('SSE：响应头与协议正确', async () => {
  const restore = mockFetch(() => llmStream([roleFrame, frame('你好'), 'data: [DONE]\n\n']))
  try {
    const res = await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.1'), okEnv)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('Content-Type') ?? '', /text\/event-stream/)
    assert.match(res.headers.get('Cache-Control') ?? '', /no-cache/)
    assert.match(res.headers.get('Cache-Control') ?? '', /no-transform/)
    assert.equal(res.headers.get('X-Accel-Buffering'), 'no')
  } finally {
    restore()
  }
})

test('SSE：首帧带额度，末帧为 done', async () => {
  const restore = mockFetch(() => llmStream([roleFrame, frame('你好'), 'data: [DONE]\n\n']))
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.2'), {
        ...okEnv,
        CHAT_QUOTA: makeKv(),
      }),
    )
    assert.equal(events[0].type, 'meta')
    assert.equal(events[0].model, 'agnes-3.0-flash')
    assert.ok(events[0].dailyLimit > 0)
    assert.equal(events.at(-1).type, 'done')
  } finally {
    restore()
  }
})

test('SSE：只推送非空 content（跳过 role 首帧与空串）', async () => {
  const restore = mockFetch(() => llmStream([roleFrame, frame(''), frame('A'), frame('B'), 'data: [DONE]\n\n']))
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.3'), okEnv),
    )
    const deltas = events.filter(e => e.type === 'delta')
    assert.deepEqual(deltas.map(d => d.text), ['A', 'B'])
  } finally {
    restore()
  }
})

test('SSE：一个帧跨多个 chunk 到达也能正确重组', async () => {
  const whole = frame('Hello World')
  const cut = Math.floor(whole.length / 2)
  const restore = mockFetch(() => llmStream([whole.slice(0, cut), whole.slice(cut), 'data: [DONE]\n\n']))
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.4'), okEnv),
    )
    const deltas = events.filter(e => e.type === 'delta')
    assert.deepEqual(deltas.map(d => d.text), ['Hello World'], '跨 chunk 的帧内容必须完整')
  } finally {
    restore()
  }
})

test('SSE：逐字节拆分也不会丢内容（多字节字符安全）', async () => {
  const bytes = new TextEncoder().encode(frame('中文测试内容'))
  const restore = mockFetch(() => llmStream([...bytes].map(b => new Uint8Array([b]))))
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.5'), okEnv),
    )
    const deltas = events.filter(e => e.type === 'delta')
    assert.deepEqual(deltas.map(d => d.text), ['中文测试内容'], 'UTF-8 被切断时不应产生乱码')
  } finally {
    restore()
  }
})

test('SSE：忽略注释行与非 data 字段', async () => {
  const restore = mockFetch(() =>
    llmStream([': keep-alive\n\n', 'event: message\n', frame('ok'), 'data: [DONE]\n\n']),
  )
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.6'), okEnv),
    )
    assert.deepEqual(events.filter(e => e.type === 'delta').map(d => d.text), ['ok'])
  } finally {
    restore()
  }
})

test('SSE：单个坏帧被跳过，不中断整条流', async () => {
  const restore = mockFetch(() =>
    llmStream([frame('前'), 'data: {这不是 JSON}\n\n', frame('后'), 'data: [DONE]\n\n']),
  )
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.7'), okEnv),
    )
    assert.deepEqual(events.filter(e => e.type === 'delta').map(d => d.text), ['前', '后'])
    assert.equal(events.at(-1).type, 'done')
  } finally {
    restore()
  }
})

test('SSE：上游中途断开时发 error 事件而非静默截断', async () => {
  const restore = mockFetch(() => {
    const enc = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(frame('半句')))
      },
      pull(controller) {
        controller.error(new Error('connection reset'))
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  })
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.8'), okEnv),
    )
    assert.equal(events.at(-1).type, 'error', '应发 error 事件告知前端')
    assert.match(events.at(-1).message, /连接中断/)
  } finally {
    restore()
  }
})

test('SSE：上游未发 [DONE] 直接结束时补发 done', async () => {
  const restore = mockFetch(() => llmStream([frame('内容')]))
  try {
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '30.0.0.9'), okEnv),
    )
    assert.equal(events.at(-1).type, 'done', '正常结束也必须有 done，前端据此收尾')
    assert.deepEqual(events.filter(e => e.type === 'delta').map(d => d.text), ['内容'])
  } finally {
    restore()
  }
})

test('SSE：向上游请求流式，且系统提示含技能上下文', async () => {
  let seenBody = null
  const restore = mockFetch((url, init) => {
    assert.match(url, /\/chat\/completions$/)
    seenBody = JSON.parse(String(init.body))
    return llmStream([frame('ok'), 'data: [DONE]\n\n'])
  })
  try {
    await handleChat(
      postRequest(
        { messages: [{ role: 'user', content: '怎么写文档' }], context: { title: 'PDF 处理', category: 'office' } },
        '30.0.0.10',
      ),
      okEnv,
    )
    assert.equal(seenBody.stream, true, '必须向上游请求流式')
    assert.match(seenBody.messages[0].content, /PDF 处理/)
    assert.equal(JSON.stringify(seenBody).includes('test-key'), false, '密钥不能出现在请求体里')
  } finally {
    restore()
  }
})

test('handleChat：模型只返回空内容时，流里没有任何 delta', async () => {
  // 流本身是 200（无法再改状态码），由前端发现「一个 delta 都没有」后提示重试
  const restore = mockFetch(() => llmStream([roleFrame, frame(''), 'data: [DONE]\n\n']))
  try {
    const res = await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '7.7.7.7'), okEnv)
    assert.equal(res.status, 200)
    const events = await readEvents(res)
    assert.equal(events.filter(e => e.type === 'delta').length, 0)
    assert.equal(events.at(-1).type, 'done')
  } finally {
    restore()
  }
})

test('handleChat：LLM 抛异常时返回 502 而不是崩溃', async () => {
  const restore = mockFetch(() => {
    throw new Error('network down')
  })
  try {
    const res = await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '8.8.8.8'), okEnv)
    assert.equal(res.status, 502)
    assert.match((await res.json()).error, /网络异常/)
  } finally {
    restore()
  }
})

test('handleChat：畸形请求不消耗每日额度', async () => {
  /*
   * 回归测试：限额检查必须排在请求体校验之后。
   * 否则一个坏客户端或探测程序可以用垃圾请求把当天额度耗光，
   * 而这些请求根本没调用过模型。
   */
  const store = new Map()
  const kv = {
    get: async k => store.get(k) ?? null,
    put: async (k, v) => {
      store.set(k, v)
    },
  }
  const restore = mockFetch(() => llmOk())
  try {
    const env = { ...okEnv, CHAT_QUOTA: kv, CHAT_DAILY_LIMIT: '2', CHAT_RATE_LIMIT: '100' }
    // 6 个畸形请求，各用不同 IP 以避开每 IP 限流
    const bad = [
      '{ 不是 JSON',
      JSON.stringify({ messages: [] }),
      JSON.stringify({ messages: [{ role: 'user', content: '' }] }),
      JSON.stringify({ messages: [{ role: 'assistant', content: 'hi' }] }),
      JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(2001) }] }),
      JSON.stringify({ messages: [{ role: 'user', content: 'a' }], extra: 1 }).slice(0, -1),
    ]
    for (const [i, body] of bad.entries()) {
      const res = await handleChat(postRequest(body, `20.0.0.${i + 1}`), env)
      assert.equal(res.status, 400, `第 ${i + 1} 个畸形请求应返回 400`)
    }
    assert.equal(store.size, 0, '畸形请求不应写入额度计数器')

    // 额度没被占用，正常请求仍然可用
    const events = await readEvents(
      await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '20.0.0.99'), env),
    )
    assert.equal(events[0].type, 'meta')
    assert.equal(events[0].dailyUsed, 1, '额度应从 1 开始算，说明前面的畸形请求没消耗')
  } finally {
    restore()
  }
})

test('handleChat：KV 故障时降级为内存计数而非拒绝服务', async () => {
  const brokenKv = {
    get: async () => {
      throw new Error('kv down')
    },
    put: async () => {
      throw new Error('kv down')
    },
  }
  const restore = mockFetch(() => llmOk())
  try {
    const res = await handleChat(
      postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '9.9.9.9'),
      { ...okEnv, CHAT_QUOTA: brokenKv, CHAT_DAILY_LIMIT: '10000', CHAT_RATE_LIMIT: '10' },
    )
    assert.equal(res.status, 200, 'KV 挂掉不应该让聊天不可用')
  } finally {
    restore()
  }
})

test('handleChat：KV 正常时按额度累加', async () => {
  const kv = makeKv()
  const restore = mockFetch(() => llmStream([frame('ok'), 'data: [DONE]\n\n']))
  try {
    for (let i = 1; i <= 3; i++) {
      const events = await readEvents(
        await handleChat(
          postRequest({ messages: [{ role: 'user', content: `q${i}` }] }, `11.11.11.${i}`),
          { ...okEnv, CHAT_QUOTA: kv, CHAT_DAILY_LIMIT: '10', CHAT_RATE_LIMIT: '10' },
        ),
      )
      assert.equal(events[0].dailyUsed, i)
    }
    const keys = [...kv.dump().keys()]
    assert.equal(keys.length, 1, '同一天应共用一个计数器键')
    assert.match(keys[0], /^chat:\d{4}-\d{2}-\d{2}$/)
  } finally {
    restore()
  }
})

test('handleChat：额度用尽后返回 429', async () => {
  const kv = {
    get: async () => '500',
    put: async () => {},
  }
  const restore = mockFetch(() => llmOk())
  try {
    const res = await handleChat(
      postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '12.12.12.12'),
      { ...okEnv, CHAT_QUOTA: kv, CHAT_DAILY_LIMIT: '500', CHAT_RATE_LIMIT: '10' },
    )
    assert.equal(res.status, 429)
    assert.match((await res.json()).error, /额度已用完/)
  } finally {
    restore()
  }
})

test('handleChat：响应含 nosniff，避免 MIME 嗅探', async () => {
  const restore = mockFetch(() => llmOk())
  try {
    const res = await handleChat(postRequest({ messages: [{ role: 'user', content: 'hi' }] }, '13.13.13.13'), okEnv)
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff')
    // SSE 用 no-cache + no-transform：既不让中间层缓存，也禁止缓冲破坏流式
    assert.match(res.headers.get('Cache-Control') ?? '', /no-cache/)
    assert.match(res.headers.get('Cache-Control') ?? '', /no-transform/)
  } finally {
    restore()
  }
})

test('handleChat：流开始之前的失败仍是普通 JSON（可读错误文案）', async () => {
  const restore = mockFetch(() => llmOk())
  try {
    const res = await handleChat(postRequest({ messages: [] }, '14.14.14.14'), okEnv)
    assert.equal(res.status, 400)
    assert.match(res.headers.get('Content-Type') ?? '', /application\/json/)
    assert.match(res.headers.get('Cache-Control') ?? '', /no-store/)
    const data = await res.json()
    assert.ok(data.error, '错误响应体应带可读文案')
  } finally {
    restore()
  }
})
