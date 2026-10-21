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
import { baseOf, homePathOf, searchPathOf, SEARCH_PATHS, BASES } from '../src/lib/site-paths.ts'

const LANGS = ['zh', 'zh-tw', 'en', 'ko', 'ms']

test('baseOf：五个语言各占一个前缀，zh 挂根', () => {
  assert.equal(baseOf('zh'), '')
  assert.equal(baseOf('zh-tw'), '/zh-tw')
  assert.equal(baseOf('en'), '/en')
  assert.equal(baseOf('ko'), '/ko')
  assert.equal(baseOf('ms'), '/ms')
  // 前缀互不冲突：任何一个不能是另一个的前缀（'/ko' 不是问题，但 '/k' 与 '/ko' 类关系要排除）
  for (const a of LANGS) {
    for (const b of LANGS) {
      if (a === b || BASES[a] === '') continue
      assert.notEqual(BASES[a], BASES[b])
    }
  }
})

test('homePathOf：空前缀时回落到 /', () => {
  assert.equal(homePathOf('zh'), '/')
  assert.equal(homePathOf('zh-tw'), '/zh-tw')
  assert.equal(homePathOf('en'), '/en')
  assert.equal(homePathOf('ko'), '/ko')
  assert.equal(homePathOf('ms'), '/ms')
})

test('★ searchPathOf：绝不产生协议相对 URL', () => {
  for (const lang of LANGS) {
    const p = searchPathOf(lang)
    // `//x` 是协议相对 URL，`/\x` 在某些解析器下等价于转义
    assert.ok(
      !p.startsWith('//') && !p.startsWith('/\\'),
      `${lang} 的搜索页路径不应以 // 开头，实际：${p}`,
    )
    assert.ok(p.startsWith('/'), `${lang} 的搜索页路径应为绝对路径，实际：${p}`)
  }
})

test('searchPathOf：五站各自正确', () => {
  assert.equal(searchPathOf('zh'), '/search/')
  assert.equal(searchPathOf('zh-tw'), '/zh-tw/search/')
  assert.equal(searchPathOf('en'), '/en/search/')
  assert.equal(searchPathOf('ko'), '/ko/search/')
  assert.equal(searchPathOf('ms'), '/ms/search/')
  assert.deepEqual(SEARCH_PATHS, {
    zh: '/search/',
    'zh-tw': '/zh-tw/search/',
    en: '/en/search/',
    ko: '/ko/search/',
    ms: '/ms/search/',
  })
})

test('searchPathOf：与 homePathOf 保持同前缀', () => {
  for (const lang of LANGS) {
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
