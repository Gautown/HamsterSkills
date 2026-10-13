/**
 * 服务商速率限制的识别与全局节流。
 *
 * 独立成模块是为了能脱离网络单测：判定、退避计算、冷却共享都是纯逻辑，
 * 只有 sleep 需要注入。
 *
 * 为什么需要它（实测踩过的坑）：
 *   批量请求撞上 429 后，若沿用「拆成单条重试」的兜底，
 *   一个 20 条的批次会变成 20 个请求——在限流期间把请求量放大 20 倍，
 *   结果是整轮回填大面积失败。正确做法是等限流窗口过去，
 *   重试**同一个批次**，并让所有并发 worker 一起等。
 */

/** 退避基数与上限（毫秒） */
const BASE_BACKOFF_MS = 5000
const MAX_BACKOFF_MS = 60_000

/**
 * 服务商侧的速率/额度限制。
 * 与普通错误区分开，因为两者的重试策略完全不同。
 */
export class RateLimitError extends Error {
  /**
   * @param {number|null} retryAfterSec 服务端 Retry-After 指定的秒数，可能没有
   * @param {number} [status] 上游 HTTP 状态码，便于日志排查
   */
  constructor(retryAfterSec = null, status = 429) {
    super('服务商速率限制')
    this.name = 'RateLimitError'
    this.retryAfterSec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : null
    this.status = status
  }
}

/**
 * 从响应头解析 Retry-After。
 * 只接受纯秒数；HTTP 日期格式返回 null（退化为指数退避）。
 */
export function parseRetryAfter(header) {
  if (!header) return null
  const n = Number(header)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 判断一个错误是否是速率限制 */
export function isRateLimit(error) {
  return error instanceof RateLimitError
}

/**
 * 计算第 attempt 次重试应等待的毫秒数。
 * 服务端指定的 Retry-After 优先于本地退避——对方说了算。
 *
 * @param {number} attempt 从 0 开始的第几次重试
 * @param {number|null} retryAfterSec
 * @param {number} [maxBackoffMs]
 */
export function backoffMs(attempt, retryAfterSec = null, maxBackoffMs = MAX_BACKOFF_MS) {
  const local = Math.min(maxBackoffMs, BASE_BACKOFF_MS * 2 ** attempt)
  const server = retryAfterSec ? retryAfterSec * 1000 : 0
  return Math.max(local, server)
}

/**
 * 全局节流器：所有并发 worker 共享一份冷却状态。
 *
 * 没有它的话，每个 worker 各自退避，总并发并没有降下来——
 * 只是把同一时刻的失败推迟了几秒。
 *
 * @param {{now?: () => number, sleep?: (ms: number) => Promise<void>}} [deps] 注入时钟与等待，便于测试
 */
export function createThrottle(deps = {}) {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  let until = 0

  return {
    /** 剩余冷却毫秒数 */
    remaining() {
      return Math.max(0, until - now())
    },

    /**
     * 进入冷却。并发 worker 会一起等到冷却结束。
     * @param {number|null} retryAfterSec
     * @param {number} attempt
     * @param {number} [maxBackoffMs]
     * @returns {number} 实际冷却毫秒数
     */
    penalize(retryAfterSec = null, attempt = 0, maxBackoffMs = MAX_BACKOFF_MS) {
      const delay = backoffMs(attempt, retryAfterSec, maxBackoffMs)
      // 取更长者：多个 worker 同时撞上限时不要互相缩短冷却
      until = Math.max(until, now() + delay)
      return delay
    },

    /** 若处于冷却则等待到结束 */
    async waitIfCooling() {
      const remain = this.remaining()
      if (remain > 0) await sleep(remain)
    },
  }
}

/**
 * 带节流与退避地执行一个请求函数。
 *
 * - 非限流错误直接抛出，交由调用方决定是否降级处理
 * - 限流错误则退避后重试**同一个请求**，绝不拆分成更多请求
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} opts
 * @param {ReturnType<typeof createThrottle>} opts.throttle
 * @param {number} [opts.retries] 限流重试次数
 * @param {number} [opts.maxBackoffMs]
 * @param {(delay: number, attempt: number) => void} [opts.onBackoff]
 * @returns {Promise<T>}
 */
export async function withRateLimitRetry(fn, opts) {
  const { throttle, retries = 5, maxBackoffMs = MAX_BACKOFF_MS, onBackoff } = opts
  for (let attempt = 0; ; attempt++) {
    await throttle.waitIfCooling()
    try {
      return await fn()
    } catch (error) {
      if (!isRateLimit(error)) throw error
      if (attempt >= retries) throw error
      const delay = throttle.penalize(error.retryAfterSec, attempt, maxBackoffMs)
      onBackoff?.(delay, attempt)
    }
  }
}
