/**
 * isSkillFile 的规则测试。
 *
 * 这个函数是整条流水线的入口闸门：判 false 的文件后面抓取、判定、
 * 分类、入库一步都不会发生。历史事故（Q3 采样窗口写错）就是
 * 「静默少东西」，构建绿灯、一路无报错，只有看页面才发现。
 *
 * 注意：这里刻意**锁住当前的 skip 语义**（只匹配路径根部的目录名），
 * 而不是它看起来应该的样子。改语义会改动入库语料，属产品决策，
 * 不能顺手在测试里改掉 —— 但必须有测试记录现状，将来改时才看得见差异。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSkillFile, SKILL_FILENAME } from '../src/lib/skill-file.ts'

/** 与 src/loaders/github-skills.ts 的 DEFAULT_SKIP 保持一致 */
const DEFAULT_SKIP = ['template', 'templates', '.github', 'node_modules', 'dist', 'build']

test('文件名必须是 skill.md，大小写不敏感', () => {
  for (const name of ['skill.md', 'SKILL.md', 'Skill.MD']) {
    assert.equal(isSkillFile(name, {}), true, name)
  }
  // 只认 SKILL.md 这一个名字
  assert.equal(isSkillFile('README.md', {}), false)
  assert.equal(isSkillFile('skill.yaml', {}), false)
})

test('只匹配完整文件名，不做子串/后缀宽松匹配', () => {
  assert.equal(isSkillFile('a/SKILL.mdx', {}), false)
  assert.equal(isSkillFile('a/SKILL.md.bak', {}), false)
  assert.equal(isSkillFile('a/skill.md/deep.txt', {}), false)
  assert.equal(isSkillFile('a/myskill.md', {}), false)
})

test('任意层级目录下的 skill.md 都算', () => {
  assert.equal(isSkillFile('a/SKILL.md', {}), true)
  assert.equal(isSkillFile('a/b/c/d/SKILL.md', {}), true)
})

test('反斜杠归一为正斜杠', () => {
  assert.equal(isSkillFile('a\\b\\SKILL.md', {}), true)
})

test('SKILL_FILENAME 常量与规则一致', () => {
  assert.equal(SKILL_FILENAME, 'skill.md')
  assert.equal(isSkillFile(SKILL_FILENAME, {}), true)
})

test('cfg.path 限定扫描范围', () => {
  assert.equal(isSkillFile('skills/pdf/SKILL.md', { path: 'skills' }), true)
  // 范围外的直接排除
  assert.equal(isSkillFile('pdf/SKILL.md', { path: 'skills' }), false)
  // 配了 path 时根目录的 skill.md 不在范围内
  assert.equal(isSkillFile('skill.md', { path: 'skills' }), false)
  // 恰好等于前缀的目录本身算范围内
  assert.equal(isSkillFile('skills/SKILL.md', { path: 'skills' }), true)
})

test('cfg.path 两侧斜杠会被忽略', () => {
  // 配置里写 "/skills/"、"/skills"、"skills" 应完全等价
  for (const p of ['skills', '/skills', 'skills/', '/skills/']) {
    assert.equal(isSkillFile('skills/pdf/SKILL.md', { path: p }), true, p)
    assert.equal(isSkillFile('pdf/SKILL.md', { path: p }), false, p)
  }
})

test('cfg.path 不是前缀字符串匹配', () => {
  // "skill" 不应命中 "skills"，否则会把整个仓库的 skill 都放进来
  assert.equal(isSkillFile('skills/pdf/SKILL.md', { path: 'skill' }), false)
})

test('cfg.skip 跳过目录：命中路径根部', () => {
  assert.equal(isSkillFile('templates/pdf/SKILL.md', { skip: DEFAULT_SKIP }), false)
  assert.equal(isSkillFile('templates/SKILL.md', { skip: DEFAULT_SKIP }), false)
  assert.equal(isSkillFile('dist/SKILL.md', { skip: DEFAULT_SKIP }), false)
})

test('cfg.skip 是路径段精确匹配，不是子串匹配', () => {
  // mytemplate 不该被 templates 规则误伤；redistribute 不该被 dist 误伤
  assert.equal(isSkillFile('mytemplate/SKILL.md', { skip: DEFAULT_SKIP }), true)
  assert.equal(isSkillFile('redistribute/SKILL.md', { skip: DEFAULT_SKIP }), true)
  assert.equal(isSkillFile('templates2/SKILL.md', { skip: DEFAULT_SKIP }), true)
  // 段要完整相等，distributed 不是 dist
  assert.equal(isSkillFile('a/distributed/SKILL.md', { skip: DEFAULT_SKIP }), true)
})

test('cfg.skip 按路径段匹配：嵌在子目录里的同名目录也会被跳过', () => {
  // 原来只有位于仓库根部的 templates/ 挡得住，子目录里的漏了进来。
  // 用真实缓存量过：5527 个 skill 文件里 243 个（4.40%）
  // 位于任意层级的 skip 名单目录内，集中在 5 个仓库，
  // 样本形如 tools/cc-sdd/templates/agents/.../skills/kiro-debug/SKILL.md
  assert.equal(isSkillFile('skills/templates/pdf/SKILL.md', { skip: DEFAULT_SKIP }), false)
  assert.equal(isSkillFile('tools/x/node_modules/y/SKILL.md', { skip: DEFAULT_SKIP }), false)
  assert.equal(isSkillFile('a/b/dist/SKILL.md', { skip: DEFAULT_SKIP }), false)
  assert.equal(isSkillFile('deep/nested/.github/SKILL.md', { skip: DEFAULT_SKIP }), false)
})

test('cfg.skip 在配置了 path 后同样作用于「前缀之内」的相对路径', () => {
  // path='skills' 时 relative 变成 templates/pdf/SKILL.md。
  // 改按段匹配后，不再依赖配没配 path —— 两种配置结果一致。
  assert.equal(
    isSkillFile('skills/templates/pdf/SKILL.md', { path: 'skills', skip: DEFAULT_SKIP }),
    false,
  )
  assert.equal(isSkillFile('skills/dist/pdf/SKILL.md', { path: 'skills', skip: DEFAULT_SKIP }), false)
  assert.equal(isSkillFile('skills/pdf/SKILL.md', { path: 'skills', skip: DEFAULT_SKIP }), true)
})

test('skip 支持目录名（按段）与完整相对路径前缀（按前缀）两种写法', () => {
  // 目录名 -> 任意层级都挡
  assert.equal(isSkillFile('a/b/c/SKILL.md', { skip: ['c'] }), false)
  assert.equal(isSkillFile('c/SKILL.md', { skip: ['c'] }), false)
  // 含斜杠 -> 完整前缀，必须出现在开头
  assert.equal(isSkillFile('a/b/SKILL.md', { skip: ['a/b'] }), false)
  assert.equal(isSkillFile('a/bc/SKILL.md', { skip: ['a/b'] }), true)
  // 含斜杠的条目不按段匹配：x/a/b 不该被 a/b 命中
  assert.equal(isSkillFile('x/a/b/SKILL.md', { skip: ['a/b'] }), true)
})

test('改按段匹配后，配不配 path 的结果一致', () => {
  // 这是本次改动的核心保证：skip 的命中不再随 path 配置而变。
  // 旧逻辑下 skills/templates/pdf/SKILL.md 配 path 时被挡、不配时漏过。
  const withPath = isSkillFile('skills/templates/pdf/SKILL.md', { path: 'skills', skip: DEFAULT_SKIP })
  const without = isSkillFile('skills/templates/pdf/SKILL.md', { skip: DEFAULT_SKIP })
  assert.equal(withPath, without)
  assert.equal(without, false)
})

test('skip 为空或缺失时不过滤', () => {
  assert.equal(isSkillFile('templates/pdf/SKILL.md', { skip: [] }), true)
  assert.equal(isSkillFile('templates/pdf/SKILL.md', { skip: undefined }), true)
  assert.equal(isSkillFile('templates/pdf/SKILL.md', {}), true)
})

test('先判文件名再判范围：范围外的非 skill 文件直接 false', () => {
  // 顺序不能反。若先算 relative 再判文件名，
  // 遇到范围外路径做 slice 可能得到怪异的相对路径。
  assert.equal(isSkillFile('other/README.md', { path: 'skills' }), false)
  assert.equal(isSkillFile('', {}), false)
  assert.equal(isSkillFile('/', {}), false)
})

test('纯函数：同输入恒等输出', () => {
  for (const [p, cfg] of [
    ['skills/pdf/SKILL.md', { path: 'skills', skip: DEFAULT_SKIP }],
    ['templates/x/SKILL.md', { skip: DEFAULT_SKIP }],
    ['a/SKILL.md', {}],
  ]) {
    const first = isSkillFile(p, cfg)
    for (let i = 0; i < 20; i++) assert.equal(isSkillFile(p, cfg), first, `${p} 第 ${i + 2} 次`)
  }
})