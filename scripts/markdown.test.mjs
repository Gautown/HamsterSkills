/**
 * 第三方 SKILL.md 正文清洗（node:test，零依赖，不联网）
 *
 * 运行：node --test scripts/markdown.test.mjs
 *
 * 补上 markdown.ts 的零覆盖缺口。这个模块处理 300 个公开仓库的
 * 第三方正文，误删或粘连都是用户直接可见的内容损失。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BODY_DISPLAY_LIMIT,
  isPlaceholderBody,
  renderSkillBodyForDisplay,
  renderSkillMarkdown,
} from '../src/lib/markdown.ts'

/** 去掉 HTML 标签后剩下的可读文本 */
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()

// ------------------------------------------------------------ 单元格粘连

test('★ 相邻表格单元格之间不粘连', () => {
  // 回归：td / th 原本不在 BLOCK_TAGS 里，<td>安装</td><td>npm i</td>
  // 渲染成「安装npm i」，两个单元格粘成一个词
  const out = renderSkillMarkdown('规格：<td>安装</td><td>npm i</td> 即可。')
  assert.match(textOf(out), /安装\s+npm i/, `期望「安装 npm i」有空格，实际：${textOf(out)}`)
  assert.doesNotMatch(textOf(out), /安装npm/, '单元格不应粘连')
})

test('Markdown 表格走 marked 的 table renderer，结构完整', () => {
  /*
   * 注意区分两种表格：
   *   - **Markdown 表格**（`|` 分隔）走 marked 默认 renderer，
   *     输出真实 <td> 标签，天然不会粘连，也不经过 htmlToPlainText。
   *   - **行内裸 HTML 表格**才走 renderer.html → htmlToPlainText，
   *     那才是 td/th 粘连的来源，由上面那条用例覆盖。
   * 这里只保证 Markdown 表格的结构与内容完整。
   */
  const out = renderSkillMarkdown(['| 参数 | 说明 |', '| --- | --- |', '| --dry | 只读模式 |'].join('\n'))
  assert.match(out, /<table>/, '应渲染出 table')
  assert.match(out, /<td[^>]*>\s*--dry\s*<\/td>/, '单元格内容应完整且有内边距空白')
  assert.match(out, /<td[^>]*>\s*只读模式\s*<\/td>/)
})

test('表格单元格内容完整保留', () => {
  const out = renderSkillMarkdown(['| 列 A | 列 B |', '| --- | --- |', '| 甲 | 乙 |'].join('\n'))
  assert.match(out, /甲/)
  assert.match(out, /乙/)
})

// ------------------------------------------------------------ HTML 清理

test('script / style 连内容一起丢弃', () => {
  const out = renderSkillMarkdown('前面\n\n<script>var x = 1;</script>\n\n后面')
  assert.doesNotMatch(textOf(out), /var x = 1/, 'script 内容不该出现在正文')
  assert.match(textOf(out), /前面/)
  assert.match(textOf(out), /后面/)
})

test('★ svg / template 的文字内容必须保留', () => {
  /*
   * 本站有意收录设计类技能（algorithmic-art / canvas-design 等），
   * 这类 SKILL.md 里的 <svg> / <template> 正是要展示的内容本身。
   * 若被当作「纯装饰」连内容删除，页面会出现大段空白。
   */
  const svg = renderSkillMarkdown('示例\n\n<svg width="100"><text x="10">图例说明</text></svg>\n\n这样就能画出图标。')
  assert.match(textOf(svg), /图例说明/, 'SVG 内的文字必须保留')

  const tpl = renderSkillMarkdown('示例\n\n<template id="t"><span>核心内容</span></template>\n\n用法如上。')
  assert.match(textOf(tpl), /核心内容/, 'template 内的文字必须保留')
})

test('原始 HTML 标签被转义，不会成为可执行标记', () => {
  const out = renderSkillMarkdown('<div onclick="alert(1)">文字</div>')
  assert.doesNotMatch(out, /<div/, '不应输出真实 div 标签')
  assert.match(textOf(out), /文字/)
})

test('★ 代码块里的尖括号安全，且不经过清洗', () => {
  /*
   * 代码围栏由 marked 默认的 code renderer 处理并自行转义，
   * 根本不经过 htmlToPlainText。这条是「不要误伤」的保护。
   */
  const out = renderSkillMarkdown(['```html', '<div class="x">文字</div>', '<script>alert(1)</script>', '```'].join('\n'))
  assert.match(out, /&lt;div/, '代码块内的标签应被转义')
  assert.match(out, /&lt;script&gt;/, '代码块内的 script 应被转义')
  assert.doesNotMatch(out, /<script/, '不得输出可执行的 script 标签')
  assert.match(textOf(out), /class="x"/, '代码内容本身应完整保留')
})

test('行内代码的尖括号安全', () => {
  const out = renderSkillMarkdown('用法：`<script>alert(1)</script>`')
  assert.doesNotMatch(out, /<script/, '行内代码不得产生可执行标签')
})

// ------------------------------------------------------------ 实体往返

test('实体的反转义与再转义往返无损', () => {
  const out = renderSkillMarkdown('<p>使用 &amp; 和 &lt;tag&gt; 与 &quot;引号&quot;</p>')
  const t = textOf(out)
  assert.match(t, /&/, '应还原出 &')
  assert.match(t, /<tag>/, '应还原出 <tag>')
  assert.match(t, /"引号"/, '应还原出引号')
})

// ------------------------------------------------------------ 表格滚动容器

test('表格被包进横向滚动容器', () => {
  const out = renderSkillMarkdown(['| A | B |', '| - | - |', '| 1 | 2 |'].join('\n'))
  assert.match(out, /class="table-scroll"/, '应包一层滚动容器，避免长行撑破布局')
})

// ------------------------------------------------------------ 占位正文

test('isPlaceholderBody：识别空正文与相对路径', () => {
  assert.equal(isPlaceholderBody(''), true)
  assert.equal(isPlaceholderBody(undefined), true)
  assert.equal(isPlaceholderBody('   '), true)
  assert.equal(isPlaceholderBody('../../../commands/cs-aeo.md'), true, '相对路径应判为占位')
  assert.equal(isPlaceholderBody('# 标题\n\n这是有实质内容的正文，足够长。'), false)
})

// ------------------------------------------------------------ 截断

test('超长正文被截断，并带回可展示的元信息', () => {
  const long = '句子。'.repeat(40_000)
  const r = renderSkillBodyForDisplay(long)
  assert.ok(r.html.length < BODY_DISPLAY_LIMIT * 3, `渲染结果应受长度约束，实际 ${r.html.length}`)
  assert.equal(r.truncated, true, '应标记已截断')
  assert.ok(r.fullLength > BODY_DISPLAY_LIMIT, '应带回原始长度，供 UI 提示')
})

test('普通长度正文不截断', () => {
  const r = renderSkillBodyForDisplay('# 标题\n\n一小段正文。')
  assert.equal(r.truncated, false)
})

test('空正文不炸', () => {
  assert.equal(renderSkillMarkdown(''), '')
  assert.equal(renderSkillMarkdown(undefined), '')
  const r = renderSkillBodyForDisplay('')
  assert.equal(typeof r.html, 'string')
})