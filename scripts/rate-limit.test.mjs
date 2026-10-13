/**
 * 速率限制识别与全局节流（node:test，零依赖，不联网）
 *
 * 运行：node --test scripts/rate-limit.test.mjs
 *
 * 这些用例锁定的是一个真实踩过的坑：
 *   批量请求撞 429 后若沿用「拆成单条重试」，20 条会变成 20 个请求，
 *   在限流期间把请求量放大 20 倍，导致整轮回填大面积失败。
 * 时钟与 sleep 均可注入，因此退避逻辑可以瞬间验证，不必真的等。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RateLimitError,
  backoffMs,
  createThrottle,
  isRateLimit,
  parseRetryAfter,
  withRateLimitRetry,
} from '../src/lib/rate-limit.mjs'

/** 可控时钟 + 记录 sleep 次数的假等待器 */
function fakeClock() {
  let t = 0
  const sleeps = []
  return {
    now: () => t,
    sleep: async ms => {
      sleeps.push(ms)
      t += ms
    },
    advance: ms => {
      t += ms
    },
    sleeps,
    get elapsed() {
      return t
    },
  }
}

/* ------------------------------ parseRetryAfter ------------------------------ */

test('parseRetryAfter：接受纯秒数', () => {
  assert.equal(parseRetryAfter('30'), 30)
  assert.equal(parseRetryAfter('1'), 1)
})

test('parseRetryAfter：缺失/非法/HTTP 日期返回 null', () => {
  assert.equal(parseRetryAfter(null), null)
  assert.equal(parseRetryAfter(''), null)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT'), null)
  assert.equal(parseRetryAfter('-5'), null)
})

/* -------------------------------- backoffMs -------------------------------- */

test('backoffMs：指数退避 5s/10s/20s/40s/60s 封顶', () => {
  assert.equal(backoffMs(0), 5000)
  assert.equal(backoffMs(1), 10000)
  assert.equal(backoffMs(2), 20000)
  assert.equal(backoffMs(3), 40000)
  assert.equal(backoffMs(4), 60000)
  assert.equal(backoffMs(10), 60000, '必须有上限，否则第 20 次要等 58 小时')
})

test('backoffMs：Retry-After 优先于本地退避', () => {
  assert.equal(backoffMs(0, 120), 120000, '服务端要等 120 秒就等 120 秒')
  assert.equal(backoffMs(0, 1), 5000, '服务端只要 1 秒时仍按本地退避，不至于过于激进')
})

/* ------------------------------ createThrottle ------------------------------ */

test('节流器：penalize 后进入冷却，waitIfCooling 会等到结束', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  assert.equal(throttle.remaining(), 0)

  throttle.penalize(null, 0)
  assert.equal(throttle.remaining(), 5000)

  await throttle.waitIfCooling()
  assert.equal(clock.sleeps.length, 1)
  assert.equal(throttle.remaining(), 0, '等完应归零')
})

test('节流器：未冷却时 waitIfCooling 不等待', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  await throttle.waitIfCooling()
  assert.equal(clock.sleeps.length, 0)
})

test('节流器：多个 worker 同时撞限流时取更长冷却，不互相缩短', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  throttle.penalize(null, 0) // 5s
  clock.advance(1000)
  throttle.penalize(null, 3) // 40s，但此时应保持 40s 而非变成 41s
  assert.equal(throttle.remaining(), 40000, '应取 max，不是累加或覆盖成更短值')
})

test('节流器：冷却随时间自然流逝', () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  throttle.penalize(null, 0)
  assert.equal(throttle.remaining(), 5000)
  clock.advance(4999)
  assert.equal(throttle.remaining(), 1)
  clock.advance(1)
  assert.equal(throttle.remaining(), 0)
})

/* --------------------------- withRateLimitRetry --------------------------- */

test('成功路径：只调用一次，不退避', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  let calls = 0
  const r = await withRateLimitRetry(
    async () => {
      calls++
      return 'ok'
    },
    { throttle },
  )
  assert.equal(r, 'ok')
  assert.equal(calls, 1)
  assert.equal(clock.sleeps.length, 0)
})

test('★ 限流：重试同一个请求，请求数不放大', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  let calls = 0
  const r = await withRateLimitRetry(
    async () => {
      calls++
      if (calls <= 3) throw new RateLimitError(null)
      return 'ok'
    },
    { throttle, retries: 5 },
  )
  assert.equal(r, 'ok')
  assert.equal(calls, 4, '4 次调用只对应 1 个逻辑请求，绝不能被拆成多个')
  assert.deepEqual(clock.sleeps, [5000, 10000, 20000], '退避应指数增长')
})

test('退避耗尽后抛出限流错误，不无限重试', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  let calls = 0
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        calls++
        throw new RateLimitError(null)
      },
      { throttle, retries: 2 },
    ),
    err => {
      assert.ok(isRateLimit(err))
      return true
    },
  )
  assert.equal(calls, 3, '首发 + 2 次重试')
})

test('★ 非限流错误立即抛出，不退避也不重试', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  let calls = 0
  await assert.rejects(
    withRateLimitRetry(
      async () => {
        calls++
        throw new Error('JSON 解析失败')
      },
      { throttle, retries: 5 },
    ),
    /JSON 解析失败/,
  )
  assert.equal(calls, 1, '普通错误重试没有意义')
  assert.equal(clock.sleeps.length, 0, '普通错误不应触发退避')
})

test('退避会采纳服务端 Retry-After', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  let calls = 0
  await withRateLimitRetry(
    async () => {
      calls++
      if (calls === 1) throw new RateLimitError(30)
      return 'ok'
    },
    { throttle, retries: 2 },
  )
  assert.deepEqual(clock.sleeps, [30000], '应等 Retry-After 指定的 30 秒')
})

test('★ 并发 worker 共享冷却：一个撞限流后，其他 worker 起步即被拦住', async () => {
  /*
   * 用不自动推进时钟的假 sleep，否则前一个 worker 等完冷却后，
   * 后一个自然看不到冷却，测不出「共享」这件事。
   */
  const sleeps = []
  let t = 0
  const throttle = createThrottle({
    now: () => t,
    sleep: async ms => {
      sleeps.push(ms)
    },
  })

  // worker A 撞上限流并进入冷却（此时不推进时钟，冷却仍在生效）
  let a = 0
  const pending = withRateLimitRetry(
    async () => {
      a++
      if (a === 1) throw new RateLimitError(null)
      return 'A'
    },
    { throttle, retries: 1 },
  )
  // 让 A 跑到 penalize 之后
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(throttle.remaining() > 0, 'A 应已进入冷却')

  // worker B 此时才起步：它没有独立的计数，必须被同一份冷却拦住
  await withRateLimitRetry(async () => 'B', { throttle, retries: 0 })

  assert.ok(sleeps.length >= 2, `B 应等待 A 设置的共享冷却，实际 sleep ${sleeps.length} 次`)
  assert.ok(
    sleeps.slice(1).every(ms => ms > 0),
    'B 的等待时长应来自共享冷却而非 0',
  )
  await pending
})

test('onBackoff 回调收到实际冷却时长与次数', async () => {
  const clock = fakeClock()
  const throttle = createThrottle({ now: clock.now, sleep: clock.sleep })
  const seen = []
  let calls = 0
  await withRateLimitRetry(
    async () => {
      calls++
      if (calls <= 2) throw new RateLimitError(null)
      return 'ok'
    },
    { throttle, retries: 3, onBackoff: (delay, attempt) => seen.push({ delay, attempt }) },
  )
  assert.deepEqual(seen, [
    { delay: 5000, attempt: 0 },
    { delay: 10000, attempt: 1 },
  ])
})

/* ------------------------------- RateLimitError ------------------------------- */

test('RateLimitError：保存状态码与 Retry-After', () => {
  const e = new RateLimitError(12, 429)
  assert.equal(e.name, 'RateLimitError')
  assert.equal(e.status, 429)
  assert.equal(e.retryAfterSec, 12)
  assert.ok(isRateLimit(e))
})

test('RateLimitError：非法 Retry-After 归一为 null', () => {
  assert.equal(new RateLimitError(null).retryAfterSec, null)
  assert.equal(new RateLimitError(NaN).retryAfterSec, null)
  assert.equal(new RateLimitError(-1).retryAfterSec, null)
})

test('isRateLimit：普通错误不算限流', () => {
  assert.equal(isRateLimit(new Error('boom')), false)
  assert.equal(isRateLimit(null), false)
  assert.equal(isRateLimit('429'), false)
})
