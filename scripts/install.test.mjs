/**
 * 安装通道回归测试。
 *
 * 这些字符串会被用户原样粘进终端、或被官方 skills CLI 解析：
 *   - 命令拼错 → 用户侧静默失败（最难排查的一类故障）
 *   - dl 产物的 frontmatter 不合规 → CLI 校验不过，安装直接失败
 * 所以边界（URL 转换、参数顺序、YAML 转义、描述长度上限）都由单测钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_SKILL_NAME_RE,
  installSourceOf,
  buildInstallCommand,
  buildAgentSkillMd,
} from '../src/lib/install.ts'

/* ------------------------------ installSourceOf ------------------------------ */

test('远端技能：优先使用源仓库 tree URL（与 CLI 格式零转换匹配）', () => {
  const url = 'https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder'
  assert.equal(installSourceOf({ github: url, id: 'web-artifacts-builder' }), url)
})

test('本地技能：回退到本站 /dl/<id>.md 下载通道', () => {
  assert.equal(
    installSourceOf({ id: 'csv-analysis', origin: 'https://skill.gautown.top' }),
    'https://skill.gautown.top/dl/csv-analysis.md',
  )
})

test('origin 末尾斜杠被归一（不产生双斜杠 URL）', () => {
  assert.equal(
    installSourceOf({ id: 'x', origin: 'https://skill.gautown.top/' }),
    'https://skill.gautown.top/dl/x.md',
  )
})

test('github 为空串 / 无值时的回退行为', () => {
  // 空串视为没有源（mapSkillData 不会产出空串，但判空要防御）
  assert.equal(installSourceOf({ github: '', id: 'x', origin: 'https://a.b' }), 'https://a.b/dl/x.md')
  // 两者都缺 → null（调用方隐藏安装入口）
  assert.equal(installSourceOf({ id: 'x' }), null)
  assert.equal(installSourceOf({ github: '', id: 'x' }), null)
})

/* ------------------------------ buildInstallCommand ------------------------------ */

const TREE = 'https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder'
const DL = 'https://skill.gautown.top/dl/csv-analysis.md'

test('★ 全局安装命令包含 -g/-a/-y（可非交互执行）', () => {
  assert.equal(
    buildInstallCommand({ source: TREE, agent: 'opencode', global: true }),
    `npx skills add ${TREE} -g -a opencode -y`,
  )
})

test('项目安装命令不含 -g', () => {
  assert.equal(
    buildInstallCommand({ source: TREE, agent: 'codex', global: false }),
    `npx skills add ${TREE} -a codex -y`,
  )
})

test('不带 agent 时省略 -a（CLI 自动识别目标工具）', () => {
  assert.equal(buildInstallCommand({ source: TREE, global: true }), `npx skills add ${TREE} -g -y`)
  assert.equal(buildInstallCommand({ source: TREE, global: false }), `npx skills add ${TREE} -y`)
})

test('dl 下载 URL 可用于命令（CLI 支持 SKILL.md 直链）', () => {
  assert.equal(
    buildInstallCommand({ source: DL, agent: 'claude-code', global: true }),
    `npx skills add ${DL} -g -a claude-code -y`,
  )
})

test('所有 -a 取值都来自 CLI 官方 agent 表（防拼错）', () => {
  // 这 6 个是菜单固定提供的工具，取值必须与 docs/agents.md 一致
  const known = ['opencode', 'claude-code', 'codex', 'cursor', 'github-copilot', 'hermes-agent']
  for (const agent of known) {
    const cmd = buildInstallCommand({ source: TREE, agent, global: true })
    assert.ok(cmd.includes(`-a ${agent} `), `${agent} 应出现在命令中`)
    assert.ok(cmd.endsWith('-y'), `${agent} 命令应以 -y 收尾`)
  }
})

/* ------------------------------ buildAgentSkillMd ------------------------------ */

const parseFrontmatter = (md) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md)
  assert.ok(m, '必须以 frontmatter 开头')
  const fm = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(': ')
    if (i > 0) fm[line.slice(0, i)] = line.slice(i + 2)
  }
  return { fm, body: md.slice(m[0].length) }
}

test('★ 生成的 SKILL.md：name 合规 + description 为规范要求的引号标量', () => {
  const md = buildAgentSkillMd({
    id: 'csv-analysis',
    descriptionEn: 'Profile a dataset: overview, key metrics, anomaly detection, and a one-line conclusion.',
    body: '# CSV Analysis\n\nSteps here.',
  })
  const { fm } = parseFrontmatter(md)
  assert.equal(fm.name, 'csv-analysis')
  assert.ok(AGENT_SKILL_NAME_RE.test(fm.name))
  // 描述含冒号 → 必须是合法的引号标量（JSON 字符串恰好是合法 YAML）
  const desc = JSON.parse(fm.description)
  assert.equal(desc, 'Profile a dataset: overview, key metrics, anomaly detection, and a one-line conclusion.')
})

test('描述优先级：descriptionEn > description > id', () => {
  const a = buildAgentSkillMd({ id: 'x', descriptionEn: 'EN', description: 'ZH', body: 'b' })
  assert.equal(JSON.parse(parseFrontmatter(a).fm.description), 'EN')
  const b = buildAgentSkillMd({ id: 'x', description: 'ZH', body: 'b' })
  assert.equal(JSON.parse(parseFrontmatter(b).fm.description), 'ZH')
  const c = buildAgentSkillMd({ id: 'fallback-id', body: 'b' })
  assert.equal(JSON.parse(parseFrontmatter(c).fm.description), 'fallback-id')
})

test('★ 超长描述截断到规范上限（1024 含省略号）', () => {
  const md = buildAgentSkillMd({ id: 'x', descriptionEn: 'x'.repeat(3000), body: 'b' })
  const desc = JSON.parse(parseFrontmatter(md).fm.description)
  assert.equal(desc.length, 1024)
  assert.ok(desc.endsWith('…'))
})

test('描述里的换行/引号不会破坏 YAML（JSON 标量天然安全）', () => {
  const tricky = 'Line one\nLine "two" — line: three'
  const md = buildAgentSkillMd({ id: 'x', descriptionEn: tricky, body: 'b' })
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md)
  assert.ok(m, 'frontmatter 必须正常闭合')
  // 描述内的换行必须是转义形态：frontmatter 块恰好两行（name + description），
  // 不允许出现裸换行把块撑开
  assert.equal(m[1].split('\n').length, 2)
  assert.ok(m[1].includes('\\n'), '换行应以 \\n 转义出现在标量里')
  const { fm } = parseFrontmatter(md)
  assert.equal(JSON.parse(fm.description), tricky)
})

test('prompt 追加为「## Prompt」小节；body 原样保留', () => {
  const md = buildAgentSkillMd({
    id: 'csv-analysis',
    descriptionEn: 'd',
    body: '# Title\n\ncontent',
    prompt: '你是数据分析师',
  })
  const { body } = parseFrontmatter(md)
  assert.ok(body.includes('# Title\n\ncontent'))
  assert.ok(body.includes('## Prompt\n\n你是数据分析师'))
  assert.ok(md.endsWith('\n'))
})

test('没有 body / prompt 时不产出空小节', () => {
  const md = buildAgentSkillMd({ id: 'x', descriptionEn: 'd' })
  const { body } = parseFrontmatter(md)
  assert.equal(body.trim(), '')
  assert.ok(!md.includes('## Prompt'))
})

/* ------------------------------ name 正则 ------------------------------ */

test('★ name 正则：接受规范 id、拒绝常见非法形态', () => {
  for (const ok of ['csv-analysis', 'pdf', 'a1-b2-c3', '0x0funky-agent']) {
    assert.ok(AGENT_SKILL_NAME_RE.test(ok), `${ok} 应合规`)
  }
  for (const bad of ['Upper', '-lead', 'trail-', 'a--b', 'a_b', 'a b', '中文', '']) {
    assert.ok(!AGENT_SKILL_NAME_RE.test(bad), `${bad} 应判非法`)
  }
})
