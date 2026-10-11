import fs from 'node:fs'

/** 刷新后审计：覆盖率、生态点名、截断仓库、dist 指标。用法：node scripts/audit.mjs */
const root = process.cwd()
const dir = root + '/.cache/skills-remote'
const disc = JSON.parse(fs.readFileSync(dir + '/_discovery.json', 'utf8'))
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_discovery.json')
const probed = new Set(files.map(f => f.replace(/\.json$/, '').replace('__', '/')))

const missing = disc.repos.filter(r => !probed.has(r.repo))
console.log('=== coverage ===')
console.log('probed:', probed.size, '/', disc.repos.length, '| missing:', missing.length)
for (const r of missing) console.log('  MISS ★' + r.stars, r.repo)

let total = 0
const perRepo = new Map()
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'))
    const n = Object.keys(j.files).length
    total += n
    perRepo.set(f.replace(/\.json$/, '').replace('__', '/'), n)
  } catch { }
}
console.log('=== cache ===')
console.log('cached SKILL.md total:', total, '(总量上限 12000)')

console.log('=== ecosystem spot-check ===')
const targets = [
  'anomalyco/opencode', 'NousResearch/hermes-agent', 'RobinBeraud/hermes-skills', '0xNyk/awesome-hermes-agent',
  'prompt-security/clawsec', 'coldteadotai/abide', 'sunchaokun/PPT-Design-Skill', 'hqhq1025/skill-optimizer',
  'berserkdisruptors/contextual-commits', 'konraddzbik/architecture-diagram-skill', 'weisser-dev/awesome-opencode',
  'bighadj22/opencode-skill', 'pacifio/atlas', 'Weizhena/Deep-Research-skills',
]
for (const t of targets) {
  const n = perRepo.get(t)
  console.log('  ', n != null ? String(n).padStart(4) + ' files' : '  MISSING ', t)
}

console.log('=== capped repos（单仓 200 上限截断）===')
const capped = []
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8'))
    if (j.cappedFiles) capped.push(f.replace('.json', '').replace('__', '/'))
  } catch { }
}
console.log('count:', capped.length)
console.log(' ', capped.join(', ').slice(0, 600))

try {
  const home = fs.readFileSync(root + '/dist/index.html', 'utf8')
  const m = home.match(/全部[\s\S]{0,80}?(\d+)/)
  console.log('=== dist ===')
  console.log('home total zh:', m ? m[1] : '?', `| index.html = ${(fs.statSync(root + '/dist/index.html').size / 1e6).toFixed(2)} MB`)
  const idxPath = root + '/dist/skills-index.json'
  if (fs.existsSync(idxPath)) console.log('skills-index.json:', (fs.statSync(idxPath).size / 1e6).toFixed(2), 'MB')
  const tags = fs.readdirSync(root + '/dist/tags')
  console.log('tag pages:', tags.length, '| illegal dirs:', tags.filter(t => /[:*?"<>|#%]/.test(t)).length)
  const sm = fs.readFileSync(root + '/dist/sitemap-0.xml', 'utf8')
  console.log('sitemap urls:', (sm.match(/<loc>/g) || []).length)
  console.log('en skill pages:', fs.readdirSync(root + '/dist/en/skills').length, '| zh skill pages:', fs.readdirSync(root + '/dist/skills').length)
} catch (e) {
  console.log('dist check error', e.message)
}
console.log('audit done')
