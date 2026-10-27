/**
 * 管理后台 API（模块化，可被 node --test 直测；见 scripts/admin.test.mjs）。
 *
 * 端点（全部经 zh Worker；run_worker_first 只放行 /api/*，静态页零打扰）：
 *   GET  /api/site-config        公开：站点展示参数 + 广告模块开关。
 *                                前端运行时加载器取用（Layout.astro），
 *                                HTTP 缓存 2 分钟 + 页面 localStorage 镜像 5 分钟。
 *   POST /api/admin/setup        首次初始化管理员。仅当凭据不存在时可用，
 *                                且要求 x-setup-key == ADMIN_SETUP_KEY（fail-closed：
 *                                未配置该 secret 时整条通道关闭，防止陌生人抢注）。
 *   POST /api/admin/login       登录（每 IP 每分钟 5 次；PBKDF2 校验；签发会话）。
 *   GET  /api/admin/session     会话有效性探针。
 *   POST /api/admin/logout      登出（会话键立即覆写失效，1 秒后由 KV 清理）。
 *   GET  /api/admin/config      读取完整配置（需会话）。
 *   PUT  /api/admin/config      写入配置（需会话 + 同源）。
 *   POST /api/admin/credentials 改账户/密码（需会话 + 同源 + 当前密码复核）。
 *
 * 存储全部落在 SITE_KV（与聊天计数共用一个 KV namespace，键前缀隔离，
 * 省一次「wrangler kv namespace create + 改配置」的人工步骤）：
 *   cfg:site     站点配置 JSON（normalizeSiteConfig 之后的形状）
 *   adm:cred     管理员凭据 {u, s, h, i}——PBKDF2-SHA256 哈希 + 盐，绝不存明文
 *   adm:ses:*    会话（随机 256bit token → {u, exp}，TTL 24 小时）
 *   adm:rl:*     登录限流计数（每 IP 每分钟，KV eventual consistency 下 best-effort）
 *
 * 所需 Secrets（wrangler secret put -c wrangler.zh.jsonc）：
 *   ADMIN_SETUP_KEY  后台首次初始化的引导密钥；不配置则 setup 通道整体关闭
 */
import type { KvNamespace } from './chat'
/*
 * 显式 .ts 扩展名：Worker 打包器两种写法都收，但 Node 原生 ESM（node --test
 * 直测本模块）只认带扩展名的相对导入——chat.ts 无值导入所以没踩过这个坑。
 */
import { safeEqual } from './refresh-auth.ts'

export interface AdminEnv {
  SITE_KV?: KvNamespace
  ADMIN_SETUP_KEY?: string
}

/* ------------------------------- 常量 ------------------------------- */

/** KV 键名：凭据 / 站点配置 / 会话 / 登录限流 */
const CRED_KEY = 'adm:cred'
const CONFIG_KEY = 'cfg:site'
const sessionKey = (token: string) => `adm:ses:${token}`
const rateKey = (ip: string) => `adm:rl:${ip}`

/** 会话有效期（秒）——与 cookie Max-Age、KV expirationTtl 三处保持一致 */
const SESSION_TTL_SEC = 86_400
/** 登录尝试：每 IP 每 60 秒最多 5 次 */
const LOGIN_MAX_PER_MIN = 5
/** PBKDF2 迭代次数：OWASP 2023 对 PBKDF2-SHA256 的建议下限 */
export const PBKDF2_ITERATIONS = 100_000

const COOKIE_NAME = 'hamster_admin'

/* --------------------------- 站点配置形状 --------------------------- */

export interface SiteText {
  name?: string
  desc?: string
  footerNote?: string
}

export interface AdsConfig {
  enabled: boolean
  sideRails: 'off' | 'left' | 'both'
  anchor: boolean
  vignette: boolean
}

export interface SiteConfig {
  site: SiteText
  ads: AdsConfig
}

/**
 * 未保存任何配置时的行为基线：
 * 广告开、只保留左侧 Side Rail、anchor/插屏关——
 * 与「后台从未配置」时的站点现状完全一致。
 */
export const DEFAULT_SITE_CONFIG: SiteConfig = {
  site: {},
  ads: { enabled: true, sideRails: 'left', anchor: false, vignette: false },
}

/** 展示文本字段的上限：配置端会截断，前端不必再校验 */
const TEXT_LIMITS = { name: 40, desc: 120, footerNote: 80 } as const

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const t = value.trim().replace(/\s+/g, ' ')
  if (!t) return undefined
  return t.slice(0, max)
}

function cleanBool(value: unknown, dflt: boolean): boolean {
  return typeof value === 'boolean' ? value : dflt
}

/**
 * 归一化任意输入为合法 SiteConfig：
 * 未知字段丢弃、文本截断、非法枚举回退默认。写入前与读取后都过这一层，
 * KV 里就算被手工写坏，对外吐出的也永远是合法形状。
 */
export function normalizeSiteConfig(raw: unknown): SiteConfig {
  const root = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const siteIn = (root.site && typeof root.site === 'object' ? root.site : {}) as Record<string, unknown>
  const ads = (root.ads && typeof root.ads === 'object' ? root.ads : {}) as Record<string, unknown>
  const side = ads.sideRails

  /* 未设置的字段直接省略键（而非置 undefined）：KV 序列化后更小，deepEqual 也更直观 */
  const site: SiteText = {}
  const name = cleanText(siteIn.name, TEXT_LIMITS.name)
  if (name !== undefined) site.name = name
  const desc = cleanText(siteIn.desc, TEXT_LIMITS.desc)
  if (desc !== undefined) site.desc = desc
  const footerNote = cleanText(siteIn.footerNote, TEXT_LIMITS.footerNote)
  if (footerNote !== undefined) site.footerNote = footerNote

  return {
    site,
    ads: {
      enabled: cleanBool(ads.enabled, true),
      sideRails: side === 'off' || side === 'left' || side === 'both' ? side : DEFAULT_SITE_CONFIG.ads.sideRails,
      anchor: cleanBool(ads.anchor, DEFAULT_SITE_CONFIG.ads.anchor),
      vignette: cleanBool(ads.vignette, DEFAULT_SITE_CONFIG.ads.vignette),
    },
  }
}

/* ------------------------------ 凭据 ------------------------------ */

/** 账户/密码的形状约束；返回 null 表示合法，否则返回给用户看的错误文案 */
export function validateCredential(username: string, password: string): string | null {
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return '用户名需为 3-32 位字母、数字或 . _ -'
  if (password.length < 8 || password.length > 128) return '密码长度需在 8-128 位之间'
  return null
}

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const s = atob(b64)
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/* TS 5.9 起 Uint8Array 按底层 buffer 泛型化：salt 必须是 ArrayBuffer 视图才满足 BufferSource */
async function deriveBits(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  return toHex(new Uint8Array(bits))
}

export interface HashedCredential {
  /** 盐（base64） */
  s: string
  /** PBKDF2-SHA256 哈希（hex） */
  h: string
  /** 迭代次数（存下来，未来调参后老凭据仍可验） */
  i: number
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<HashedCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return { s: toB64(salt), h: await deriveBits(password, salt, iterations), i: iterations }
}

export async function verifyPassword(password: string, cred: unknown): Promise<boolean> {
  const c = (cred && typeof cred === 'object' ? cred : {}) as Record<string, unknown>
  if (typeof c.s !== 'string' || typeof c.h !== 'string') return false
  const iterations = typeof c.i === 'number' && c.i > 0 && c.i <= 1_000_000 ? c.i : PBKDF2_ITERATIONS
  const salt = fromB64(c.s)
  if (!salt) return false
  return safeEqual(await deriveBits(password, salt, iterations), c.h)
}

/* ------------------------------ 会话 ------------------------------ */

/** 256bit 随机会话令牌（hex），URL/cookie 安全字符集 */
export function makeToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

export function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = v
  }
  return out
}

function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SEC}`
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

function bearerToken(request: Request): string {
  return parseCookies(request.headers.get('Cookie') ?? '')[COOKIE_NAME] ?? ''
}

/**
 * 同源校验（CSRF 第二道防线；第一道是 SameSite=Strict cookie）。
 * 现代浏览器对跨站 POST 一定带 Origin，缺失时放行以兼容极老浏览器。
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

type SessionGate = { ok: true; username: string } | { ok: false; response: Response }

async function requireSession(request: Request, env: AdminEnv): Promise<SessionGate> {
  const token = bearerToken(request)
  if (!token) return { ok: false, response: json({ error: '未登录' }, 401) }
  const raw = await env.SITE_KV!.get(sessionKey(token))
  if (!raw) return { ok: false, response: json({ error: '会话已过期，请重新登录' }, 401) }
  let s: { u?: unknown; exp?: unknown }
  try {
    s = JSON.parse(raw)
  } catch {
    return { ok: false, response: json({ error: '会话无效' }, 401) }
  }
  if (typeof s.u !== 'string' || typeof s.exp !== 'number' || s.exp < Date.now()) {
    return { ok: false, response: json({ error: '会话已过期，请重新登录' }, 401) }
  }
  return { ok: true, username: s.u }
}

/* ------------------------------ 工具 ------------------------------ */

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      ...extraHeaders,
    },
  })
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await request.json()
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 登录限流：KV 计数 + 60 秒 TTL。eventual consistency 下 best-effort，够用。 */
async function loginLimited(env: AdminEnv, ip: string): Promise<boolean> {
  const key = rateKey(ip)
  const raw = await env.SITE_KV!.get(key)
  const n = raw ? Math.max(0, parseInt(raw, 10) || 0) : 0
  if (n >= LOGIN_MAX_PER_MIN) return true
  await env.SITE_KV!.put(key, String(n + 1), { expirationTtl: 60 })
  return false
}

/* --------------------------- 配置读写 --------------------------- */

async function readConfig(env: AdminEnv): Promise<SiteConfig> {
  if (!env.SITE_KV) return DEFAULT_SITE_CONFIG
  const raw = await env.SITE_KV.get(CONFIG_KEY)
  if (!raw) return DEFAULT_SITE_CONFIG
  try {
    return normalizeSiteConfig(JSON.parse(raw))
  } catch {
    return DEFAULT_SITE_CONFIG
  }
}

/* ----------------------------- 端点 ----------------------------- */

async function publicConfig(env: AdminEnv): Promise<Response> {
  const config = await readConfig(env)
  return json(config, 200, { 'Cache-Control': 'public, max-age=120' })
}

async function setup(request: Request, env: AdminEnv): Promise<Response> {
  if (!env.ADMIN_SETUP_KEY) {
    return json({ error: '未配置 ADMIN_SETUP_KEY，初始化通道关闭（wrangler secret put ADMIN_SETUP_KEY -c wrangler.zh.jsonc 后重试）' }, 503)
  }
  if (!safeEqual(request.headers.get('x-setup-key') ?? '', env.ADMIN_SETUP_KEY)) {
    return json({ error: '初始化密钥不正确' }, 401)
  }
  if (await env.SITE_KV!.get(CRED_KEY)) {
    return json({ error: '管理员已初始化；如需重置请先删除 KV 键 adm:cred' }, 409)
  }
  const body = await readBody(request)
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400)
  const username = str(body.username)
  const password = str(body.password)
  const problem = validateCredential(username, password)
  if (problem) return json({ error: problem }, 400)
  const cred = await hashPassword(password)
  await env.SITE_KV!.put(CRED_KEY, JSON.stringify({ u: username, ...cred }))
  return json({ ok: true })
}

async function login(request: Request, env: AdminEnv): Promise<Response> {
  const body = await readBody(request)
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400)
  const username = str(body.username)
  const password = str(body.password)
  if (!username || !password) return json({ error: '请输入账户与密码' }, 400)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  if (await loginLimited(env, ip)) return json({ error: '尝试过于频繁，请 1 分钟后再试' }, 429)

  const credRaw = await env.SITE_KV!.get(CRED_KEY)
  if (!credRaw) return json({ error: '管理员尚未初始化，请先用初始化密钥创建账户', needSetup: true }, 401)
  let cred: unknown
  try {
    cred = JSON.parse(credRaw)
  } catch {
    return json({ error: '凭据数据损坏；请删除 KV 键 adm:cred 后重新初始化' }, 500)
  }
  const okPassword = await verifyPassword(password, cred)
  const savedUser = (cred as { u?: unknown }).u
  if (!okPassword || savedUser !== username) return json({ error: '账户或密码不正确' }, 401)

  const token = makeToken()
  const exp = Date.now() + SESSION_TTL_SEC * 1000
  await env.SITE_KV!.put(sessionKey(token), JSON.stringify({ u: username, exp }), { expirationTtl: SESSION_TTL_SEC })
  return json({ ok: true, username }, 200, { 'Set-Cookie': sessionCookie(token) })
}

async function logout(request: Request, env: AdminEnv): Promise<Response> {
  const token = bearerToken(request)
  if (token) {
    // 接口没有 delete：把会话键覆写成 1 秒 TTL 的失效标记，等 KV 自动回收
    await env.SITE_KV!.put(sessionKey(token), '{"revoked":true}', { expirationTtl: 1 })
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() })
}

async function putConfig(request: Request, env: AdminEnv, username: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: '跨站请求被拒绝' }, 403)
  const body = await readBody(request)
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400)
  const config = normalizeSiteConfig(body)
  await env.SITE_KV!.put(CONFIG_KEY, JSON.stringify(config))
  console.log(`[admin] ${username} 更新站点配置`)
  return json({ ok: true, config })
}

async function changeCredentials(request: Request, env: AdminEnv, username: string): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: '跨站请求被拒绝' }, 403)
  const body = await readBody(request)
  if (!body) return json({ error: '请求体不是合法 JSON' }, 400)
  const current = str(body.currentPassword)
  const credRaw = await env.SITE_KV!.get(CRED_KEY)
  if (!credRaw) return json({ error: '凭据缺失' }, 500)
  let cred: unknown
  try {
    cred = JSON.parse(credRaw)
  } catch {
    return json({ error: '凭据数据损坏' }, 500)
  }
  if (!(await verifyPassword(current, cred))) return json({ error: '当前密码不正确' }, 401)

  const nextUsername = str(body.username) || username
  const nextPassword = str(body.newPassword) || current
  const problem = validateCredential(nextUsername, nextPassword)
  if (problem) return json({ error: problem }, 400)
  const hashed = await hashPassword(nextPassword)
  await env.SITE_KV!.put(CRED_KEY, JSON.stringify({ u: nextUsername, ...hashed }))
  console.log(`[admin] ${username} 修改了账户凭据`)
  return json({ ok: true })
}

/* ----------------------------- 入口 ----------------------------- */

export async function handleAdminApi(request: Request, env: AdminEnv): Promise<Response> {
  const { pathname } = new URL(request.url)

  // 公开端点不要求 SITE_KV：未绑定时返回默认配置，前端加载器走内置基线
  if (pathname === '/api/site-config') return publicConfig(env)

  if (!pathname.startsWith('/api/admin/')) return json({ error: '未知接口' }, 404)
  if (!env.SITE_KV) return json({ error: '后台存储未绑定（SITE_KV）' }, 503)
  const route = `${request.method} ${pathname.slice('/api/admin/'.length)}`

  switch (route) {
    case 'POST setup':
      return setup(request, env)
    case 'POST login':
      return login(request, env)
    case 'POST logout':
      return logout(request, env)
    case 'GET session': {
      const gate = await requireSession(request, env)
      if (gate.ok === false) return gate.response
      return json({ ok: true, username: gate.username })
    }
    case 'GET config': {
      const gate = await requireSession(request, env)
      if (gate.ok === false) return gate.response
      return json({ ok: true, config: await readConfig(env) })
    }
    case 'PUT config': {
      const gate = await requireSession(request, env)
      if (gate.ok === false) return gate.response
      return putConfig(request, env, gate.username)
    }
    case 'POST credentials': {
      const gate = await requireSession(request, env)
      if (gate.ok === false) return gate.response
      return changeCredentials(request, env, gate.username)
    }
    default:
      return json({ error: '未知接口' }, 404)
  }
}
