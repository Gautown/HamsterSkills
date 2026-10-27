/**
 * 管理后台 API 测试（node:test，零依赖）
 *
 * 运行：node --test scripts/admin.test.mjs
 * （package.json 的 test 脚本会带上所有 scripts/*.test.mjs）
 *
 * 覆盖：配置归一化、凭据校验/哈希往返、cookie 解析、令牌生成、
 * 以及 handleAdminApi 的完整端点流（setup → login → session → config → 改密 → 登出、限流）。
 * KV 用内存假件；PBKDF2 迭代次数调低以提速（逻辑不变，只是少算几轮）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SITE_CONFIG,
  handleAdminApi,
  hashPassword,
  makeToken,
  normalizeSiteConfig,
  parseCookies,
  validateCredential,
  verifyPassword,
} from '../src/worker/admin.ts'

/* ------------------------------ 测试辅助 ------------------------------ */

class FakeKV {
  constructor() {
    this.map = new Map()
  }
  get(key) {
    return Promise.resolve(this.map.get(key) ?? null)
  }
  put(key, value) {
    this.map.set(key, value)
    return Promise.resolve()
  }
}

const base = 'https://skill.gautown.top'
const jsonReq = (method, path, body, extraHeaders = {}) =>
  new Request(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9', ...extraHeaders },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const env = (kv, setupKey) => ({ SITE_KV: kv, ADMIN_SETUP_KEY: setupKey })

/** 从 Set-Cookie 头取会话令牌 */
const tokenOf = (res) => (res.headers.get('Set-Cookie') ?? '').match(/hamster_admin=([0-9a-f]+)/)?.[1] ?? ''

/* --------------------------- 配置归一化 --------------------------- */

test('normalizeSiteConfig：空输入回默认基线', () => {
  assert.deepEqual(normalizeSiteConfig(null), DEFAULT_SITE_CONFIG)
  assert.deepEqual(normalizeSiteConfig({}), DEFAULT_SITE_CONFIG)
  assert.deepEqual(normalizeSiteConfig('垃圾'), DEFAULT_SITE_CONFIG)
})

test('normalizeSiteConfig：截断、去空白、枚举回退、未知字段丢弃', () => {
  const cfg = normalizeSiteConfig({
    site: { name: '  新   名字 ', desc: 'x'.repeat(300), footerNote: '  ', evil: '<script>' },
    ads: { enabled: 'no', sideRails: 'everywhere', anchor: 1, vignette: true },
    other: { a: 1 },
  })
  assert.equal(cfg.site.name, '新 名字')
  assert.equal(cfg.site.desc.length, 120)
  assert.equal(cfg.site.footerNote, undefined)
  assert.equal(cfg.site.evil, undefined)
  assert.equal(cfg.ads.enabled, true)
  assert.equal(cfg.ads.sideRails, 'left')
  assert.equal(cfg.ads.anchor, false)
  assert.equal(cfg.ads.vignette, true)
  assert.equal(cfg.other, undefined)
})

/* ------------------------------ 凭据 ------------------------------ */

test('validateCredential：账户与密码规则', () => {
  assert.equal(validateCredential('admin', '12345678'), null)
  assert.ok(validateCredential('ab', '12345678'))
  assert.ok(validateCredential('非法用户名', '12345678'))
  assert.ok(validateCredential('admin', '1234567'))
  assert.ok(validateCredential('admin', 'x'.repeat(129)))
})

test('PBKDF2 哈希往返：正确密码过、错误密码不过、畸形凭据安全失败', async () => {
  const cred = await hashPassword('correct horse', 512)
  assert.equal(cred.i, 512)
  assert.ok(await verifyPassword('correct horse', cred))
  assert.ok(!(await verifyPassword('wrong horse', cred)))
  assert.ok(!(await verifyPassword('x', null)))
  assert.ok(!(await verifyPassword('x', { s: '!!', h: 'aa' })))
  assert.ok(!(await verifyPassword('x', { s: 'AAAA', h: 'aa', i: 'NaN' })))
})

test('makeToken：64 位 hex 且互不重复', () => {
  const a = makeToken()
  const b = makeToken()
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, b)
})

test('parseCookies', () => {
  assert.deepEqual(parseCookies('hamster_admin=abc; other=x=y'), { hamster_admin: 'abc', other: 'x=y' })
  assert.deepEqual(parseCookies(''), {})
})

/* --------------------------- 端点流程 --------------------------- */

test('公开配置：无 KV 返回默认；写后读回归一化结果', async () => {
  const kv = new FakeKV()
  const noKv = await handleAdminApi(new Request(base + '/api/site-config'), { SITE_KV: undefined })
  assert.equal(noKv.status, 200)
  assert.deepEqual(await noKv.json(), DEFAULT_SITE_CONFIG)

  await kv.map.set('cfg:site', JSON.stringify({ site: { name: '站长站' }, ads: { sideRails: 'both' } }))
  const res = await handleAdminApi(new Request(base + '/api/site-config'), env(kv))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('Cache-Control') ?? '', /public/)
  const cfg = await res.json()
  assert.equal(cfg.site.name, '站长站')
  assert.equal(cfg.ads.sideRails, 'both')
  assert.equal(cfg.ads.enabled, true)
})

test('未初始化时登录提示初始化；未配置 SETUP_KEY 时初始化通道整体关闭', async () => {
  const kv = new FakeKV()
  const login = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'admin', password: '12345678' }), env(kv, 'k'))
  assert.equal(login.status, 401)
  assert.equal((await login.json()).needSetup, true)

  const noKey = await handleAdminApi(jsonReq('POST', '/api/admin/setup', { username: 'admin', password: '12345678' }, { 'x-setup-key': 'k' }), env(kv, undefined))
  assert.equal(noKey.status, 503)
})

test('初始化 → 登录 → 会话 → 改配置 → 改密 → 登出 全流程', async () => {
  const kv = new FakeKV()

  // 错密钥 401
  const bad = await handleAdminApi(jsonReq('POST', '/api/admin/setup', { username: 'boss', password: 'password9' }, { 'x-setup-key': 'wrong' }), env(kv, 'secret'))
  assert.equal(bad.status, 401)

  // 正确密钥初始化
  const setup = await handleAdminApi(jsonReq('POST', '/api/admin/setup', { username: 'boss', password: 'password9' }, { 'x-setup-key': 'secret' }), env(kv, 'secret'))
  assert.equal(setup.status, 200)

  // 重复初始化 409
  const again = await handleAdminApi(jsonReq('POST', '/api/admin/setup', { username: 'x', password: 'password9' }, { 'x-setup-key': 'secret' }), env(kv, 'secret'))
  assert.equal(again.status, 409)

  // 未登录读配置 401
  const locked = await handleAdminApi(new Request(base + '/api/admin/config'), env(kv, 'secret'))
  assert.equal(locked.status, 401)

  // 错密码登录失败
  const wrong = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'boss', password: 'nope1234' }), env(kv, 'secret'))
  assert.equal(wrong.status, 401)

  // 正确登录 → 拿会话 cookie
  const login = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'boss', password: 'password9' }), env(kv, 'secret'))
  assert.equal(login.status, 200)
  const setCookie = login.headers.get('Set-Cookie') ?? ''
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const token = tokenOf(login)
  assert.ok(token)

  // 会话探针
  const sess = await handleAdminApi(new Request(base + '/api/admin/session', { headers: { Cookie: `hamster_admin=${token}` } }), env(kv, 'secret'))
  assert.equal(sess.status, 200)
  assert.equal((await sess.json()).username, 'boss')

  // 写配置（带合法 Origin）
  const put = await handleAdminApi(
    new Request(base + '/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `hamster_admin=${token}`, Origin: base },
      body: JSON.stringify({ site: { name: '站长站' }, ads: { enabled: true, sideRails: 'both', anchor: false, vignette: false } }),
    }),
    env(kv, 'secret'),
  )
  assert.equal(put.status, 200)

  // 公开端点读回
  const pub = await (await handleAdminApi(new Request(base + '/api/site-config'), env(kv, 'secret'))).json()
  assert.equal(pub.site.name, '站长站')
  assert.equal(pub.ads.sideRails, 'both')

  // 改密：当前密码错 → 401
  const badCred = await handleAdminApi(
    jsonReq('POST', '/api/admin/credentials', { currentPassword: 'wrongwrong', newPassword: 'newpassword1' }, { Cookie: `hamster_admin=${token}`, Origin: base }),
    env(kv, 'secret'),
  )
  assert.equal(badCred.status, 401)

  // 改密成功 → 旧密码失效、新密码可用
  const cred = await handleAdminApi(
    jsonReq('POST', '/api/admin/credentials', { currentPassword: 'password9', newPassword: 'newpassword1' }, { Cookie: `hamster_admin=${token}`, Origin: base }),
    env(kv, 'secret'),
  )
  assert.equal(cred.status, 200)
  const relapse = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'boss', password: 'password9' }, { 'CF-Connecting-IP': '8.8.8.8' }), env(kv, 'secret'))
  assert.equal(relapse.status, 401)
  const renew = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'boss', password: 'newpassword1' }, { 'CF-Connecting-IP': '8.8.4.4' }), env(kv, 'secret'))
  assert.equal(renew.status, 200)

  // 登出 → 会话立即失效
  const out = await handleAdminApi(
    jsonReq('POST', '/api/admin/logout', {}, { Cookie: `hamster_admin=${token}` }),
    env(kv, 'secret'),
  )
  assert.equal(out.status, 200)
  assert.match(out.headers.get('Set-Cookie') ?? '', /Max-Age=0/)
  const after = await handleAdminApi(new Request(base + '/api/admin/session', { headers: { Cookie: `hamster_admin=${token}` } }), env(kv, 'secret'))
  assert.equal(after.status, 401)
})

test('登录限流：同 IP 第 6 次尝试 429（计数在登录失败间也生效）', async () => {
  const kv = new FakeKV()
  for (let i = 0; i < 5; i++) {
    const r = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'ghost', password: 'password9' }), env(kv, 'x'))
    assert.ok(r.status === 401, `第 ${i + 1} 次应 401`)
  }
  const sixth = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'ghost', password: 'password9' }), env(kv, 'x'))
  assert.equal(sixth.status, 429)
})

test('跨站 PUT 被拒绝（Origin 校验）', async () => {
  const kv = new FakeKV()
  await kv.map.set('adm:cred', JSON.stringify({ u: 'boss', ...(await hashPassword('password9', 512)) }))
  const login = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'boss', password: 'password9' }), env(kv, 'x'))
  const token = tokenOf(login)
  const csrf = await handleAdminApi(
    new Request(base + '/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `hamster_admin=${token}`, Origin: 'https://evil.example' },
      body: '{}',
    }),
    env(kv, 'x'),
  )
  assert.equal(csrf.status, 403)
})

test('未知接口 404；SITE_KV 缺失时管理端点 503', async () => {
  const unknown = await handleAdminApi(new Request(base + '/api/admin/nope'), env(new FakeKV(), 'x'))
  assert.equal(unknown.status, 404)
  const noKv = await handleAdminApi(new Request(base + '/api/admin/login'), { SITE_KV: undefined })
  assert.equal(noKv.status, 503)
})
