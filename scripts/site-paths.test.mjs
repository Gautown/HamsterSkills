/**
 * 站点路径推导的回归测试。
 *
 * 这组值在构建期被写进 HTML 的 <form action> 与 <a href>，
 * 拼错时页面上表现为「搜索跳到别的站」——
 * 生产环境实测过：中文站的 action 曾经是 `//search/`，
 * 那是协议相对 URL，浏览器会解析成 `https://search/`（另一个站）。
 * 单测能在构建前拦住这类错误。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseOf, homePathOf, searchPathOf, SEARCH_PATHS } from '../src/lib/site-paths.ts'

test('baseOf：中文站在根，英文站在 /en', () => {
  assert.equal(baseOf('zh'), '')
  assert.equal(baseOf('en'), '/en')
})

test('homePathOf：空前缀时回落到 /', () => {
  assert.equal(homePathOf('zh'), '/')
  assert.equal(homePathOf('en'), '/en')
})

test('★ searchPathOf：绝不产生协议相对 URL', () => {
  for (const lang of ['zh', 'en']) {
    const p = searchPathOf(lang)
    // `//x` 是协议相对 URL，`/\x` 在某些解析器下等价于转义
    assert.ok(
      !p.startsWith('//') && !p.startsWith('/\\'),
      `${lang} 的搜索页路径不应以 // 开头，实际：${p}`,
    )
    assert.ok(p.startsWith('/'), `${lang} 的搜索页路径应为绝对路径，实际：${p}`)
  }
})

test('searchPathOf：中英两站各自正确', () => {
  assert.equal(searchPathOf('zh'), '/search/')
  assert.equal(searchPathOf('en'), '/en/search/')
  assert.deepEqual(SEARCH_PATHS, { zh: '/search/', en: '/en/search/' })
})

test('searchPathOf：与 homePathOf 保持同前缀', () => {
  for (const lang of ['zh', 'en']) {
    const home = homePathOf(lang)
    const search = searchPathOf(lang)
    // homePath 为 '/' 时 lang 前缀是空串，'/' 既是前缀也是它的一部分
    const prefix = home === '/' ? '/' : home
    assert.ok(
      search.startsWith(prefix),
      `${lang}: 搜索页 ${search} 应在 ${prefix} 之下`,
    )
  }
})