/**
 * 刷新端点的共享密钥校验。
 *
 * 从 index.ts 抽出来的原因：
 *   1. index.ts 用的是无扩展名 import（`./chat`），
 *      bundler 能解析但 Node 原生 ESM 解析不了 —— 于是 index.ts 里的
 *      任何函数都无法被 node --test 直接测到。
 *   2. 这是安全相关的判定逻辑，不该只能靠人工审查。
 *
 * 覆盖两个端点：
 *   POST /api/refresh          手动触发刷新
 *   GET  /api/refresh-status   查询上次运行状态
 *
 * 后者此前没有鉴权，等于公开暴露刷新节奏，
 * 同时充当一个能消耗 Worker 令牌额度的 GitHub API 代理。
 */

/** 常量时间比较，避免通过响应耗时侧信道逐字节猜测密钥 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 校验 `Authorization: Bearer <REFRESH_SECRET>`。
 *
 * 刻意只声明实际用到的字段，而不是 Worker 的 Env 类型：
 * 测试因此不必构造完整环境，也不会把 Worker 依赖拖进这个纯模块。
 *
 * 未配置 REFRESH_SECRET 时一律拒绝（fail-closed）：
 * 宁可端点不可用，也不能因为忘配密钥就退化成无鉴权开放。
 */
export function authorized(request: Request, env: { REFRESH_SECRET?: string }): boolean {
  const secret = env.REFRESH_SECRET
  if (!secret) return false
  return safeEqual(request.headers.get('Authorization') ?? '', `Bearer ${secret}`)
}