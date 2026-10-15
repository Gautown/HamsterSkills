/**
 * skill id 推导的回归测试。
 *
 * 为什么这组测试优先级最高：
 *   id 是全站的身份键，同时被四处共用（loader、ai-cache、ai-classify、chat-markdown）。
 *   一旦推导出错，AI 记忆库会**静默错位**——花的钱记到用不上的键上，
 *   站点构建时查不到就悄悄退回规则层，没有任何报错。
 *   而且 id 直接决定详情页 URL（/skills/<id>），
 *   改动 slugify 会静默改掉线上链接，外链与书签全断。
 *
 *   所以这里的断言不只是"当前行为是什么"，
 *   更是"线上真实存在的 id 不能变"的护栏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSkillId, slugify, skillDirectory } from '../src/lib/skill-id.mjs'

test('skillDirectory：取文件所在目录，根目录为空串', () => {
  assert.equal(skillDirectory('skills/pdf/SKILL.md'), 'skills/pdf')
  assert.equal(skillDirectory('a/b/c/SKILL.md'), 'a/b/c')
  // 仓库根目录：空串是合法结果，不是错误
  assert.equal(skillDirectory('SKILL.md'), '')
  assert.equal(skillDirectory(''), '')
})

test('skillDirectory：反斜杠归一为正斜杠', () => {
  // GitHub API 返回的一律是正斜杠，但 Windows 本地调用方可能传反斜杠。
  // 不归一的话 skillDirectory 与 slugify 会拿到不同结果，id 前后不一致。
  assert.equal(skillDirectory('skills\\pdf\\SKILL.md'), 'skills/pdf')
  assert.equal(skillDirectory('a\\b\\SKILL.md'), 'a/b')
})

test('skillDirectory：末段为空时仍然正确（传目录而非文件路径）', () => {
  assert.equal(skillDirectory('skills/pdf/'), 'skills/pdf')
})

test('slugify：小写化、非字母数字折叠、首尾去横线', () => {
  assert.equal(slugify('Pdf Analysis'), 'pdf-analysis')
  assert.equal(slugify('  a  b  '), 'a-b')
  assert.equal(slugify('--trim--'), 'trim')
  assert.equal(slugify('My Skill!'), 'my-skill')
})

test('slugify：Windows 保留设备名加后缀', () => {
  // 在 Windows 上直接建 con/aux 这类目录会失败，
  // 且它们同时是 URL 片段，容易与真实技能撞名。
  for (const name of ['CON', 'nul', 'aux', 'com1', 'COM9', 'lpt1', 'LPT9']) {
    assert.equal(slugify(name), `${name.toLowerCase()}-skill`, name)
  }
})

test('slugify：只是"看起来像"保留名的普通词不受影响', () => {
  // 正则只认 com1-9 / lpt1-9。若把它放宽成前缀匹配，
  // com10、auxiliary 这类正常目录名会被误改。
  assert.equal(slugify('lpt0'), 'lpt0')
  assert.equal(slugify('com10'), 'com10')
  assert.equal(slugify('auxiliary'), 'auxiliary')
})

test('slugify：非 ASCII 整体丢弃，可能得到空串', () => {
  // 这是设计如此，调用方必须准备 fallback（见 deriveSkillId 的第 2 条规则）。
  assert.equal(slugify('中文'), '')
  assert.equal(slugify(''), '')
})

test('deriveSkillId：取目录名最后一段', () => {
  assert.equal(deriveSkillId('skills/pdf/SKILL.md', 'demo-repo'), 'pdf')
  assert.equal(deriveSkillId('a/b/c/SKILL.md', 'demo-repo'), 'c')
})

test('deriveSkillId：文件在仓库根目录时退回仓库名', () => {
  assert.equal(deriveSkillId('SKILL.md', 'demo-repo'), 'demo-repo')
})

test('deriveSkillId：目录名 slug 化后为空时退回仓库名', () => {
  // 中文目录名会被 slugify 整体丢弃，必须退到仓库名而不是产出空 id。
  assert.equal(deriveSkillId('skills/数据分析/SKILL.md', 'demo-repo'), 'demo-repo')
})

test('deriveSkillId：目录名与仓库名都不可用时返回空串', () => {
  // 唯一会返回空串的情况。loader 用 `if (!id)` 跳过并计数，
  // 所以这里必须保持空串而不是给个占位值——占位值会造成全站批量撞 id。
  assert.equal(deriveSkillId('中文/SKILL.md', '中文'), '')
})

test('deriveSkillId：保留设备名目录仍能产出可用 id', () => {
  assert.equal(deriveSkillId('skills/CON/SKILL.md', 'demo-repo'), 'con-skill')
  assert.equal(deriveSkillId('skills/com1/SKILL.md', 'demo-repo'), 'com1-skill')
})

test('deriveSkillId：纯数字与数字开头的目录名不被破坏', () => {
  // 线上真实存在这些目录（1688 电商、stata 工具链等）。
  // 早期怀疑数字前缀是 slugify 的 bug，实测确认它们就是真实目录名。
  assert.equal(deriveSkillId('skills/1688-product-detail/SKILL.md', 'demo'), '1688-product-detail')
  assert.equal(deriveSkillId('skills/3-statement-model/SKILL.md', 'demo'), '3-statement-model')
  assert.equal(deriveSkillId('skills/007/SKILL.md', 'demo'), '007')
})

test('deriveSkillId：反斜杠路径产出与正斜杠一致的 id', () => {
  // 同一份数据经由不同调用方（loader / 离线脚本）时，id 必须逐字节相同，
  // 否则 AI 记忆库会分叉成两套键。
  const a = deriveSkillId('skills/pdf/SKILL.md', 'demo-repo')
  const b = deriveSkillId('skills\\pdf\\SKILL.md', 'demo-repo')
  assert.equal(a, b)
})

/*
 * 线上 id 稳定性护栏。
 *
 * 下面每个 id 都取自生产环境 skills-index.json 的真实条目。
 * 它们已经是公开 URL 的一部分（/skills/<id>），
 * 也是 AI 记忆库的主键。slugify 的任何改动都必须先让这里通过，
 * 否则等于批量改线上链接 + 让已有 AI 分类缓存全部失效。
 */
test('线上真实 id 不因 slugify 改动而变化', () => {
  const real = [
    ['skills/pdf/SKILL.md', 'x', 'pdf'],
    ['skills/1688-product-detail/SKILL.md', 'x', '1688-product-detail'],
    ['skills/00-andruia-consultant/SKILL.md', 'x', '00-andruia-consultant'],
    ['skills/10-andruia-skill-smith/SKILL.md', 'x', '10-andruia-skill-smith'],
    ['skills/3-statement-model/SKILL.md', 'x', '3-statement-model'],
    ['skills/007/SKILL.md', 'x', '007'],
    ['skills/autoresearch/SKILL.md', 'x', 'autoresearch'],
    ['skills/full-empirical-analysis-skill-python/SKILL.md', 'x', 'full-empirical-analysis-skill-python'],
  ]
  for (const [path, repo, expected] of real) {
    assert.equal(deriveSkillId(path, repo), expected, path)
  }
})

test('同目录名在不同仓库产出相同 id —— 碰撞由调用方拦截', () => {
  // 这是**有意**的行为：id 只由目录名决定，不含仓库名。
  // 两个仓库都有 pdf/ 目录时会得到同一个 id，
  // loader 靠 `store.has(id)` 把后来者丢弃并告警。
  //
  // 补这条断言是为了锁住"碰撞确实会发生"这个前提：
  // 如果哪天有人给 id 加上仓库前缀，loader 里的去重分支就成了死代码，
  // 而线上可能早已依赖它去丢弃重复条目。
  assert.equal(
    deriveSkillId('skills/pdf/SKILL.md', 'repo-a'),
    deriveSkillId('skills/pdf/SKILL.md', 'repo-b'),
  )
})

test('纯函数性质：同输入恒等输出，无隐藏状态', () => {
  // loader 长驻进程内跑数千次，若有内部缓存/计数器会导致
  // "第 1 次与第 2 次结果不同"这类极难排查的错位。
  for (const [p, r] of [['skills/pdf/SKILL.md', 'demo'], ['中文/SKILL.md', '中文']]) {
    const first = deriveSkillId(p, r)
    for (let i = 0; i < 50; i++) assert.equal(deriveSkillId(p, r), first, `${p} 第 ${i + 2} 次`)
  }
})

test('不抛异常：各种畸形输入都有确定结果', () => {
  const weird = [
    ['', 'demo'],
    ['/', 'demo'],
    ['///', 'demo'],
    ['SKILL.md', ''],
    ['skills/pdf/skill.md', 'demo'],
    ['skills/pdf/SKILL.MD', 'demo'],
    ['.git/config', 'demo'],
  ]
  for (const [p, r] of weird) {
    assert.equal(typeof deriveSkillId(p, r), 'string', `${JSON.stringify([p, r])}`)
  }
})