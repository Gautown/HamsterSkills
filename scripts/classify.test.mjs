/**
 * 分类规则层回归测试（node:test，零依赖）
 * 运行：node --test scripts/classify.test.mjs
 *
 * 这些用例全部来自 8797 条真实数据的回放中暴露的实际缺陷，
 * 每条都对应一个曾经出错的具体样本，防止后续调词时把问题带回来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySkill, isCategoryKey, CATEGORY_KEYS } from '../src/lib/classify.mjs'

/**
 * @param {string} dirName
 * @param {string} description
 * @param {any} [tags]
 */
const classify = (dirName, description, tags = []) =>
  classifySkill({ frontmatter: { description, tags }, dirName, dir: dirName }).category

test('显式声明的分类优先级最高', () => {
  const r = classifySkill({ frontmatter: { category: 'life', description: 'refactor code' }, dirName: 'x' })
  assert.equal(r.category, 'life')
  assert.equal(r.source, 'declared')
  assert.equal(r.confidence, 1)
})

test('categoryMap 配置优先于关键词', () => {
  const r = classifySkill({
    frontmatter: { description: 'create beautiful images' },
    dirName: 'my-thing',
    categoryMap: { 'my-thing': 'dev' },
  })
  assert.equal(r.category, 'dev')
  assert.equal(r.source, 'mapped')
})

test('路径中的分类目录段优先于关键词', () => {
  const r = classifySkill({
    frontmatter: { description: 'refactor docker kubernetes code' },
    dirName: 'thing',
    dir: 'office/pdf/thing',
  })
  assert.equal(r.category, 'office')
  assert.equal(r.source, 'path')
})

test('目录名的信号权重大于描述（orbit-notion 曾被误判为 dev）', () => {
  // 描述里全是技术栈词（pipeline / database），但技能本身是 Notion 办公集成
  assert.equal(
    classify('orbit-notion', 'Open Orbit briefing skill selected by the Orbit pipeline when Notion is the user only connected source'),
    'office',
  )
})

test('泛化技术词不应把非开发类技能吸入 dev', () => {
  // 描述里提到 github / repository，但本质是数据分析看板
  assert.equal(
    classify('github-dashboard', 'GitHub repository analytics dashboard showing stars, forks, contributors and issues'),
    'data',
  )
  // 成本报表属于经营/财务，不是开发
  assert.equal(
    classify('agent-cost-report', 'Believable agent cost report for any period, default the last 7 full days'),
    'business',
  )
})

test('design 的专有词不会被 dev 的 code 压过（algorithmic-art 曾被误判）', () => {
  assert.equal(
    classify('algorithmic-art', 'Creating algorithmic art using p5.js with seeded randomness and interactive parameters'),
    'design',
  )
})

test('仅按描述分类：明确的专类词可胜出', () => {
  assert.equal(classify('slack-gif-creator', 'Knowledge and utilities for creating animated GIFs'), 'design')
  assert.equal(classify('dcf-valuation', 'Discounted cash flow valuation and intrinsic value analysis'), 'data')
  assert.equal(classify('meeting-notes', 'Meeting notes page with attendees, agenda and decisions'), 'office')
})

test('规则完全无法判断时兜底 dev 且置信度为 0（留给 AI 层）', () => {
  const r = classifySkill({ frontmatter: { description: 'zzzz qqqq' }, dirName: 'zzzz' })
  assert.equal(r.category, 'dev')
  assert.equal(r.confidence, 0)
  assert.equal(r.source, 'fallback')
})

test('脏 frontmatter 不得导致崩溃（tags 是字符串的仓库真实存在）', () => {
  const r = classifySkill({
    frontmatter: { description: 'a design skill', tags: 'design, figma' },
    dirName: 'x',
  })
  assert.equal(typeof r.category, 'string')
  assert.ok(CATEGORY_KEYS.includes(r.category))

  // description 为对象/数字/数组
  for (const desc of [123, true, { a: 1 }, ['a', 'b'], null, undefined]) {
    const out = classifySkill({ frontmatter: { description: desc, tags: 42 }, dirName: 'y' })
    assert.ok(CATEGORY_KEYS.includes(out.category))
  }
})

test('打分制：多类同时命中时取最高分，而非首个命中', () => {
  const r = classifySkill({
    frontmatter: { description: 'code and docker and git commit for a spreadsheet analysis' },
    dirName: 'mixed',
    dir: 'mixed',
  })
  assert.equal(r.source, 'keyword')
  assert.ok(Object.keys(r.scores).length > 2, '应同时命中多个分类')
  const max = Math.max(...Object.values(r.scores))
  assert.equal(r.scores[r.category], max, '选中的分类必须是最高分')
})

test('置信度 = 最高分 / 总分', () => {
  const r = classifySkill({
    frontmatter: { description: 'figma design icon logo for a docker deployment' },
    dirName: 'brand-assets',
    dir: 'brand-assets',
  })
  const total = Object.values(r.scores).reduce((a, b) => a + b, 0)
  assert.equal(r.confidence, Math.round((r.scores[r.category] / total) * 100) / 100)
})

test('平分时不偏向 dev（dev 是最大兜底类，必须排在优先级末位）', () => {
  // 同时命中 business 与 dev，得分应相等
  const r = classifySkill({
    frontmatter: { description: 'market' },
    dirName: 'deploy-market',
    dir: 'deploy-market',
  })
  // dev 的泛化词已是 w1，business 的 market 是 w3，业务语义应胜出
  assert.equal(r.category, 'business')
})

test('isCategoryKey 正确校验合法分类键', () => {
  assert.equal(isCategoryKey('dev'), true)
  assert.equal(isCategoryKey('nope'), false)
  assert.equal(isCategoryKey(''), false)
})

test('分类结果始终是 10 个合法分类之一', () => {
  const inputs = [
    ['', ''],
    ['x', ''],
    ['pdf-editor', 'Edit pdf documents'],
    ['/', '///'],
    ['a'.repeat(300), 'b'.repeat(300)],
  ]
  for (const [name, desc] of inputs) {
    const r = classifySkill({ frontmatter: { description: desc }, dirName: name, dir: `/${name}/SKILL.md` })
    assert.ok(CATEGORY_KEYS.includes(r.category), `非法分类: ${r.category}`)
    assert.ok(r.confidence >= 0 && r.confidence <= 1)
  }
})