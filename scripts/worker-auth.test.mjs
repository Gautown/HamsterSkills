/**
 * Worker 入口的鉴权测试（node:test，零依赖）
 *
 * 覆盖两个刷新端点共用的 authorized()：
 *   - /api/refresh          POST，手动触发
 *   - /api/refresh-status   GET，查询上次运行状态
 *
 * 后者此前**没有任何鉴权**，等于公开暴露：
 * 刷新节奏（运行时间与结论）以及一个能消耗 Worker 令牌额度的
 * GitHub API 代理。全站无前端调用它，收紧不影响访客。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorized, safeEqual } from '../src/worker/refresh-auth.ts'

const SECRET = 'test-secret-value'

/** 构造一个只带 Authorization 头的请求 */
const req = (auth) =>
  new Request('https://example.com/api/refresh-status', {
    method: 'GET',
    headers: auth === undefined ? {} : { Authorization: auth },
  })

test('authorized：密钥正确时放行', () => {
  assert.equal(authorized(req(`Bearer ${SECRET}`), { REFRESH_SECRET: SECRET }), true)
})

test('authorized：无 Authorization 头一律拒绝', () => {
  assert.equal(authorized(req(undefined), { REFRESH_SECRET: SECRET }), false)
  assert.equal(authorized(req(''), { REFRESH_SECRET: SECRET }), false)
})

test('authorized：错误的密钥被拒绝', () => {
  assert.equal(authorized(req(`Bearer wrong`), { REFRESH_SECRET: SECRET }), false)
  // 大小写与前缀不符都要拒绝
  assert.equal(authorized(req(`bearer ${SECRET}`), { REFRESH_SECRET: SECRET }), false)
  assert.equal(authorized(req(SECRET), { REFRESH_SECRET: SECRET }), false)
  assert.equal(authorized(req(`Token ${SECRET}`), { REFRESH_SECRET: SECRET }), false)
})

test('authorized：密钥为前缀/超集时也拒绝', () => {
  // 只比长度不比内容会漏掉「拿前缀当密钥」这类错误配置
  assert.equal(authorized(req(`Bearer ${SECRET}x`), { REFRESH_SECRET: SECRET }), false)
  assert.equal(authorized(req(`Bearer ${SECRET.slice(0, -1)}`), { REFRESH_SECRET: SECRET }), false)
})

test('authorized：未配置 REFRESH_SECRET 时 fail-closed', () => {
  // 忘配密钥应当是「端点不可用」，而不是「端点无鉴权开放」
  for (const env of [{}, { REFRESH_SECRET: '' }, { REFRESH_SECRET: undefined }]) {
    assert.equal(authorized(req(`Bearer ${SECRET}`), env), false, JSON.stringify(env))
  }
})

test('authorized：未配置密钥时，连 "Bearer undefined" 也必须拒绝', () => {
  // 这条是上面那条的真实防线。
  //
  // 若把 `if (!secret) return false` 删掉，secret 会变成 undefined，
  // 模板串把它拼成字面量 'Bearer undefined'，
  // 于是任何发来该头的请求都会通过 —— 端点在"忘配密钥"时反而敞开。
  // 只有显式断言这一条，去掉 fail-closed 才会真的让测试变红。
  assert.equal(authorized(req('Bearer undefined'), {}), false)
  assert.equal(authorized(req('Bearer undefined'), { REFRESH_SECRET: '' }), false)
  assert.equal(authorized(req('Bearer undefined'), { REFRESH_SECRET: undefined }), false)
  // 空密钥同理：'Bearer ' 也不能放行
  assert.equal(authorized(req('Bearer '), { REFRESH_SECRET: '' }), false)
})

test('safeEqual：相同内容为真', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('', ''), true)
})

test('safeEqual：长度不同立即为假', () => {
  assert.equal(safeEqual('abc', 'abcd'), false)
  assert.equal(safeEqual('abcd', 'abc'), false)
  assert.equal(safeEqual('', 'a'), false)
})

test('safeEqual：等长但内容不同为假', () => {
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'xbc'), false)
  assert.equal(safeEqual('abc', 'xyz'), false)
})