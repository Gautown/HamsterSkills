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
  delete(key) {
    this.map.delete(key)
    return Promise.resolve()
  }
}

/** 1×1 透明 PNG 的 dataURL：logo 上传校验的最小合法样本 */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

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
  assert.deepEqual(await noKv.json(), { ...DEFAULT_SITE_CONFIG, logo: { custom: false } })

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

test('页面内容分组：归一化、长度上限、非法邮箱丢弃', () => {
  const cfg = normalizeSiteConfig({
    about: { sub: '  新副标题 ', whatBody: 'x'.repeat(700), evil: '应被丢弃' },
    contact: { email: '  bad email  ', githubBody: 'g' },
    privacy: { adsBody: 'Ezoic wording' },
  })
  assert.equal(cfg.about.sub, '新副标题')
  assert.equal(cfg.about.whatBody.length, 600)
  assert.equal(cfg.about.evil, undefined)
  assert.equal(cfg.contact.email, undefined)
  assert.equal(cfg.contact.githubBody, 'g')
  assert.equal(cfg.privacy.adsBody, 'Ezoic wording')

  const valid = normalizeSiteConfig({ contact: { email: 'hi@example.com' } })
  assert.equal(valid.contact.email, 'hi@example.com')
})

test('页面内容随配置保存并被公开端点带回', async () => {
  const kv = new FakeKV()
  await kv.map.set('adm:cred', JSON.stringify({ u: 'boss', ...(await hashPassword('password9', 512)) }))
  const login = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'boss', password: 'password9' }), env(kv, 'x'))
  const token = tokenOf(login)
  const put = await handleAdminApi(
    new Request(base + '/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: `hamster_admin=${token}`, Origin: base },
      body: JSON.stringify({ about: { sub: '改过的副标题' }, contact: { email: 'hi@example.com' }, ads: {} }),
    }),
    env(kv, 'x'),
  )
  assert.equal(put.status, 200)
  const pub = await (await handleAdminApi(new Request(base + '/api/site-config'), env(kv, 'x'))).json()
  assert.equal(pub.about.sub, '改过的副标题')
  assert.equal(pub.contact.email, 'hi@example.com')
  assert.equal(pub.privacy.sub, undefined)
})

test('新增站点字段：Hero 文案 / 版权行 归一化（截断、去空白、空值省略）', () => {
  const cfg = normalizeSiteConfig({
    site: {
      heroTitle: '  全新   标题 ',
      heroSubtitle: 'x'.repeat(300),
      heroCta1: '开始',
      heroCta2: '',
      copyright: '© 2026 仓鼠',
    },
  })
  assert.equal(cfg.site.heroTitle, '全新 标题')
  assert.equal(cfg.site.heroSubtitle.length, 160)
  assert.equal(cfg.site.heroCta1, '开始')
  assert.equal(cfg.site.heroCta2, undefined)
  assert.equal(cfg.site.copyright, '© 2026 仓鼠')
})

test('Logo：未登录 401；坏 dataURL 400；上传后公开端点可读 + 元信息、恢复默认后 404', async () => {
  const kv = new FakeKV()
  const setupKey = 'k'
  await handleAdminApi(
    jsonReq('POST', '/api/admin/setup', { username: 'boss', password: 'password9' }, { 'x-setup-key': setupKey }),
    env(kv, setupKey),
  )
  const login = await handleAdminApi(jsonReq('POST', '/api/admin/login', { username: 'boss', password: 'password9' }), env(kv, setupKey))
  const token = tokenOf(login)
  const authHeaders = { Cookie: `hamster_admin=${token}`, Origin: base }

  // 未登录上传：401
  const anon = await handleAdminApi(jsonReq('POST', '/api/admin/logo', { dataUrl: PNG_DATA_URL }), env(kv, setupKey))
  assert.equal(anon.status, 401)

  // 非图片 dataURL：400
  const bad = await handleAdminApi(
    jsonReq('POST', '/api/admin/logo', { dataUrl: 'data:text/html;base64,AAAA' }, authHeaders),
    env(kv, setupKey),
  )
  assert.equal(bad.status, 400)

  // 正常上传
  const up = await handleAdminApi(jsonReq('POST', '/api/admin/logo', { dataUrl: PNG_DATA_URL }, authHeaders), env(kv, setupKey))
  assert.equal(up.status, 200)
  const upBody = await up.json()
  assert.equal(upBody.logo.custom, true)
  assert.ok(upBody.logo.v)

  // 公开端点：字节、类型与沙箱头
  const got = await handleAdminApi(new Request(base + '/api/site-logo'), env(kv, setupKey))
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('Content-Type'), 'image/png')
  assert.match(got.headers.get('Content-Security-Policy') ?? '', /default-src 'none'/)
  assert.ok(new Uint8Array(await got.arrayBuffer()).length > 50)

  // 公开配置带上 logo 元信息（前端据此切换 /api/site-logo）
  const pub = await (await handleAdminApi(new Request(base + '/api/site-config'), env(kv, setupKey))).json()
  assert.equal(pub.logo.custom, true)

  // 恢复默认：删除后 404、元信息回到 false
  const del = await handleAdminApi(
    new Request(base + '/api/admin/logo', { method: 'DELETE', headers: { Cookie: `hamster_admin=${token}`, Origin: base } }),
    env(kv, setupKey),
  )
  assert.equal(del.status, 200)
  assert.equal((await handleAdminApi(new Request(base + '/api/site-logo'), env(kv, setupKey))).status, 404)
  const pub2 = await (await handleAdminApi(new Request(base + '/api/site-config'), env(kv, setupKey))).json()
  assert.equal(pub2.logo.custom, false)

  // 无 KV 的公开端点也不炸：404（无自定义）而不是 500
  assert.equal((await handleAdminApi(new Request(base + '/api/site-logo'), { SITE_KV: undefined })).status, 404)
})
