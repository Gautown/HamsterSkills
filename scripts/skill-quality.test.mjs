/**
 * 技能级质量判定的回归测试。
 *
 * 这些判定直接决定「内容上不上站」：判 SKIP 的技能不产页、不进索引、
 * 不进清单（AI 分类不为它花钱）。与 skill-file.ts 的教训相同——
 * 判定类函数的故障特征是「静默少东西」，只有单测能逐条钉死边界语义。
 *
 * 重点覆盖：
 *   - 阈值边界（1999 / 2000 的「严格小于」语义，防止改判定时误用 <=）
 *   - 描述缺失的各种形态（undefined / 空串 / 纯空白 / 非字符串）
 *   - 整仓比例的「严格大于」语义（恰好 90% 不剔除）
 *   - 去重的保首个语义与短描述护栏
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  judgeSkill,
  judgeRepoOutcome,
  descriptionOf,
  normalizeDesc,
  createDedupeFilter,
} from '../src/lib/skill-quality.ts'

/* ------------------------------ 工具 ------------------------------ */

const skill = (over = {}) => ({
  id: 'demo',
  repo: 'acme/skills',
  sha: 'a'.repeat(40),
  body: 'x'.repeat(3000),
  frontmatter: { name: 'demo', description: 'A usable description for the demo skill.' },
  ...over,
})

/* ------------------------------ judgeSkill：SK1 正文 ------------------------------ */

test('正文达到下限 → PASS', () => {
  const v = judgeSkill(skill({ body: 'x'.repeat(2000) }), { minBodyChars: 2000 })
  assert.equal(v.decision, 'PASS')
  assert.equal(v.code, 'OK')
})

test('★ 边界：正文恰为下限-1 判 SK1，恰为下限判 PASS（严格小于）', () => {
  const options = { minBodyChars: 2000 }
  assert.equal(judgeSkill(skill({ body: 'x'.repeat(1999) }), options).code, 'SK1')
  assert.equal(judgeSkill(skill({ body: 'x'.repeat(2000) }), options).decision, 'PASS')
})

test('正文为空 → SK1，且原因里带上实际字符数', () => {
  const v = judgeSkill(skill({ body: '' }), { minBodyChars: 2000 })
  assert.equal(v.code, 'SK1')
  assert.match(v.reason, /0 字符/)
})

test('未配置 minBodyChars 时正文多短都不判', () => {
  const v = judgeSkill(skill({ body: 'x' }), {})
  assert.equal(v.decision, 'PASS')
})

/* ------------------------------ judgeSkill：SK2 描述 ------------------------------ */

const longBody = 'x'.repeat(3000)

test('requireDescription 开启且描述缺失 → SK2', () => {
  const v = judgeSkill(skill({ body: longBody, frontmatter: { name: 'demo' } }), { requireDescription: true })
  assert.equal(v.decision, 'SKIP')
  assert.equal(v.code, 'SK2')
})

test('描述是空串 / 纯空白 → 视为缺失 → SK2', () => {
  for (const value of ['', '   ', '\n\t']) {
    const v = judgeSkill(skill({ body: longBody, frontmatter: { description: value } }), { requireDescription: true })
    assert.equal(v.code, 'SK2', `description=${JSON.stringify(value)} 应判 SK2`)
  }
})

test('描述是非字符串（数字 / 数组）→ 视为缺失 → SK2', () => {
  for (const value of [42, ['a'], { text: 'a' }, null]) {
    const v = judgeSkill(skill({ body: longBody, frontmatter: { description: value } }), { requireDescription: true })
    assert.equal(v.code, 'SK2', `description=${JSON.stringify(value)} 应判 SK2`)
  }
})

test('requireDescription 未配置 → 无描述也放行', () => {
  const v = judgeSkill(skill({ body: longBody, frontmatter: { name: 'demo' } }), {})
  assert.equal(v.decision, 'PASS')
})

test('两项都不合格时先报告 SK1（不重复报告）', () => {
  const v = judgeSkill(skill({ body: 'x', frontmatter: {} }), { minBodyChars: 2000, requireDescription: true })
  assert.equal(v.code, 'SK1')
})

/* ------------------------------ descriptionOf ------------------------------ */

test('descriptionOf：trim 后非空才算有描述', () => {
  assert.equal(descriptionOf({ description: '  hello  ' }), 'hello')
  assert.equal(descriptionOf({ description: '   ' }), null)
  assert.equal(descriptionOf({}), null)
  assert.equal(descriptionOf({ description: 123 }), null)
})

/* ------------------------------ judgeRepoOutcome ------------------------------ */

const pass = { decision: 'PASS', code: 'OK', reason: '' }
const skip = { decision: 'SKIP', code: 'SK1', reason: 'thin' }
const repeated = (n, v) => Array.from({ length: n }, () => v)

test('★ 边界：43/47（91.5%）> 90% 剔除；40/44 以下不剔除', () => {
  // 43/47 ≈ 0.9149 > 0.9 → 剔除
  assert.equal(judgeRepoOutcome([...repeated(43, skip), ...repeated(4, pass)], 0.9).drop, true)
  // 41/46 ≈ 0.8913 < 0.9 → 保留
  assert.equal(judgeRepoOutcome([...repeated(41, skip), ...repeated(5, pass)], 0.9).drop, false)
})

test('★ 边界：恰好 90% 不剔除（严格大于）', () => {
  const v = judgeRepoOutcome([...repeated(9, skip), ...repeated(1, pass)], 0.9)
  assert.equal(v.ratio, 0.9)
  assert.equal(v.drop, false)
})

test('100% 失效 → 剔除，原因含计数与百分比', () => {
  const v = judgeRepoOutcome(repeated(10, skip), 0.9)
  assert.equal(v.drop, true)
  assert.match(v.reason, /10\/10/)
  assert.match(v.reason, /100%/)
})

test('全部通过 → 不剔除', () => {
  assert.equal(judgeRepoOutcome(repeated(10, pass), 0.9).drop, false)
})

test('空仓 / 未配置比例 → 一律不剔除', () => {
  assert.equal(judgeRepoOutcome([], 0.9).drop, false)
  assert.equal(judgeRepoOutcome(repeated(10, skip), undefined).drop, false)
})

/* ------------------------------ normalizeDesc ------------------------------ */

test('规范化：大小写与连续空白折叠', () => {
  assert.equal(
    normalizeDesc('  A Long Enough Description   For The Skill \n Here '),
    'a long enough description for the skill here',
  )
})

test('★ 短描述（<30 字符）返回 null —— 不能作为重复证据', () => {
  assert.equal(normalizeDesc('Changelog'), null)
  assert.equal(normalizeDesc('x'.repeat(29)), null)
  assert.notEqual(normalizeDesc('x'.repeat(30)), null)
})

/* ------------------------------ createDedupeFilter ------------------------------ */

test('同 sha 的第二个被拒（保首个）', () => {
  const dedupe = createDedupeFilter()
  assert.equal(dedupe.accept('sha1', 'first skill description that is long enough'), true)
  assert.equal(dedupe.accept('sha1', 'a completely different description text here'), false)
})

test('规范化描述相同的第二个被拒', () => {
  const dedupe = createDedupeFilter()
  const desc = 'An identical description that is definitely longer than thirty characters'
  assert.equal(dedupe.accept('sha1', desc), true)
  assert.equal(dedupe.accept('sha2', `  ${desc.toUpperCase()}  `), false)
})

test('短描述相同不误判（同名前缀的技能很常见）', () => {
  const dedupe = createDedupeFilter()
  assert.equal(dedupe.accept('sha1', 'Changelog'), true)
  assert.equal(dedupe.accept('sha2', 'Changelog'), true)
})

test('各自不同 → 都放行', () => {
  const dedupe = createDedupeFilter()
  assert.equal(dedupe.accept('sha1', 'First unique description that is long enough to count'), true)
  assert.equal(dedupe.accept('sha2', 'Second unique description that is long enough to count'), true)
})
