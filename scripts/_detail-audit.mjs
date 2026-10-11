/**
 * 详情页布局不一致分析：统计 8797 条 skill 实际拥有哪些字段。
 * 页面是「按字段存在与否条件渲染」的，所以字段分布 = 布局差异。
 */
import fs from 'node:fs'

const ROOT = 'F:/GoghStudio/GitHub/Astro/HamsterSkills'
const j = JSON.parse(fs.readFileSync(`${ROOT}/data/skills.json`, 'utf8'))
const skills = j.skills
const n = skills.length
const pct = v => `${((v / n) * 100).toFixed(1)}%`

console.log(`样本 ${n} 条\n`)

// SkillDetail.astro 里所有条件渲染的字段
const CONDITIONAL_FIELDS = [
  'steps', 'bestFor', 'prompt', 'example', 'grade', 'score',
  'likes', 'ratingUp', 'files', 'evaluation', 'guide',
]

console.log('=== 详情页条件区块的字段覆盖率 ===')
console.log('（0 命中 = 该区块在整个站点上从不出现）\n')
for (const f of CONDITIONAL_FIELDS) {
  const cnt = skills.filter(s => s.data[f] !== undefined && s.data[f] !== null &&
    (Array.isArray(s.data[f]) ? s.data[f].length > 0 : true)).length
  const bar = '█'.repeat(Math.round((cnt / n) * 40))
  console.log(`  ${f.padEnd(12)} ${String(cnt).padStart(5)} ${pct(cnt).padStart(7)} ${bar}`)
}

console.log('\n=== 恒定字段 ===')
for (const f of ['title', 'titleEn', 'description', 'descriptionEn', 'category', 'tags', 'github', 'author']) {
  const cnt = skills.filter(s => s.data[f] !== undefined && s.data[f] !== null && s.data[f] !== '').length
  console.log(`  ${f.padEnd(14)} ${String(cnt).padStart(5)} ${pct(cnt).padStart(7)}`)
}

console.log('\n=== 标题/描述质量问题 ===')
const noTitle = skills.filter(s => !s.data.title || s.data.title === s.id || s.data.title.trim() === '')
console.log(`  标题为空或等于 id      : ${noTitle.length} (${pct(noTitle.length)})`)
const titleEqId = skills.filter(s => s.data.title === s.id)
console.log(`  标题直接等于 id        : ${titleEqId.length}`)

// 描述是 YAML 残留（如 ">"、"|"、"-"）——之前分类审计里见过
const junkDesc = skills.filter(s => {
  const d = (s.data.description || '').trim()
  return d.length > 0 && d.length <= 3 && /^[\s>|*\-:#`~[\]{}()]+$/.test(d)
})
console.log(`  描述是 YAML 残留(<=3字符): ${junkDesc.length} (${pct(junkDesc.length)})`)
if (junkDesc.length) {
  const samples = [...new Set(junkDesc.map(s => JSON.stringify(s.data.description)))].slice(0, 10)
  console.log(`    实际值: ${samples.join(', ')}`)
}

const noDesc = skills.filter(s => !s.data.description || s.data.description === s.data.title)
console.log(`  描述缺失或等于标题      : ${noDesc.length} (${pct(noDesc.length)})`)

const noTag = skills.filter(s => !s.data.tags || s.data.tags.length === 0)
console.log(`  无标签                  : ${noTag.length} (${pct(noTag.length)})`)

console.log('\n=== SKILL.md 正文格式差异 ===')
const bodies = skills.map(s => s.body || '')
const len = bodies.map(b => b.length).sort((a, b) => a - b)
const q = p => len[Math.floor(len.length * p)]
console.log(`  正文长度 min=${len[0]} p25=${q(0.25)} 中位=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${len[len.length - 1]}`)

// 正文里残留 frontmatter（loader 应已剥离，若存在说明有 bug）
const withFm = skills.filter(s => /^\s*---\s*\n[\s\S]*?\n---/.test(s.data.description || ''))
const bodyHasFm = skills.filter(s => /^﻿?---\r?\n/.test(s.body || ''))
console.log(`  正文以 --- 开头(frontmatter 未剥离): ${bodyHasFm.length}`)
if (bodyHasFm.length) console.log(`    例: ${bodyHasFm.slice(0, 3).map(s => s.id).join(', ')}`)

// 标题层级分布
const h = { h1: 0, h2: 0, h3: 0, h4plus: 0, none: 0 }
for (const b of bodies) {
  const m = b.match(/^(#{1,6})\s+/m)
  if (!m) h.none++
  else if (m[1].length === 1) h.h1++
  else if (m[1].length === 2) h.h2++
  else if (m[1].length === 3) h.h3++
  else h.h4plus++
}
console.log(`  首个标题层级: h1=${h.h1} h2=${h.h2} h3=${h.h3} h4+=${h.h4plus} 无标题=${h.none}`)

// 特殊内容
const withTable = skills.filter(s => /^\|.+\|\s*$/m.test(s.body || ''))
const withCode = skills.filter(s => /```/.test(s.body || ''))
const withHtml = skills.filter(s => /<[a-z][\s\S]{0,200}>/i.test(s.body || ''))
const withImg = skills.filter(s => /!\[[^\]]*\]\(/.test(s.body || ''))
const withHtmlTag = skills.filter(s => /<\/?(script|style|iframe|div|table|br|span)/i.test(s.body || ''))
console.log(`  含表格: ${withTable.length} | 含代码块: ${withCode.length} | 含图片: ${withImg.length}`)
console.log(`  含 HTML 标签: ${withHtml.length} | 含块级 HTML(script/div/table 等): ${withHtmlTag.length}`)
if (withHtmlTag.length) {
  console.log(`    例: ${withHtmlTag.slice(0, 5).map(s => s.id).join(', ')}`)
}

// 超长行（表格没换行会撑破布局）
const longLines = skills.filter(s => (s.body || '').split('\n').some(l => l.length > 300))
console.log(`  含超长行(>300字符): ${longLines.length}`)
if (longLines.length) console.log(`    例: ${longLines.slice(0, 5).map(s => s.id).join(', ')}`)

console.log('\n=== 按仓库来源看字段差异 ===')
const byRepo = new Map()
for (const s of skills) {
  if (!byRepo.has(s.repo)) byRepo.set(s.repo, { total: 0, withPrompt: 0 })
  const r = byRepo.get(s.repo)
  r.total++
  if (s.data.prompt) r.withPrompt++
}
const reposWithPrompt = [...byRepo.entries()].filter(([, r]) => r.withPrompt > 0)
console.log(`  总仓库数: ${byRepo.size}`)
console.log(`  含 prompt 字段的仓库: ${reposWithPrompt.length}`)
for (const [repo, r] of reposWithPrompt.slice(0, 10)) console.log(`    ${repo} (${r.withPrompt}/${r.total})`)

console.log('\n=== 本地精选 skill 对比 ===')
const localDir = `${ROOT}/src/content/skills`
const localFiles = fs.readdirSync(localDir).filter(f => f.endsWith('.md'))
console.log(`  本地 md 文件数: ${localFiles.length}`)
const localRemote = new Set(skills.map(s => s.repo))
let localInData = 0
for (const f of localFiles) {
  const id = f.replace(/\.md$/, '')
  if (skills.some(s => s.id === id)) localInData++
}
console.log(`  其中已进入 data/skills.json: ${localInData}（本地优先，glob loader 先收录）`)