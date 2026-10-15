import fs from 'node:fs'

/**
 * 刷新后审计：覆盖率、生态点名、截断仓库、dist 指标。
 * 用法：node scripts/audit.mjs
 *
 * 关键设计：**发现问题时以非 0 退出**，让 CI 真正拦得住。
 * 此前本脚本只 console.log，限流降级、覆盖率缺口这类问题
 * 会一路走到部署成功，日志里一行 warn 淹没在几千行输出中没人看见。
 */
const root = process.cwd()
const dir = root + '/.cache/skills-remote'
const disc = JSON.parse(fs.readFileSync(dir + '/_discovery.json', 'utf8'))

/*
 * 只把**仓库语料缓存**算进来。
 *
 * 目录里还有 `_manifest.json`（技能清单）与 `_discovery.json`，
 * 两者都不是某个仓库的语料。原先只排除了后者，
 * 于是清单被当成一个仓库缓存：磁盘文件数与孤儿计数各虚高 1。
 * 单看只是小数点后的失真，但它让「孤儿残留」这条线索永远为假。
 */
const NON_REPO_FILES = new Set(['_discovery.json', '_manifest.json'])
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !NON_REPO_FILES.has(f))
const probed = new Set(files.map(f => f.replace(/\.json$/, '').replace('__', '/')))

/** 需要以非 0 退出的问题 */
const problems = []

/*
 * 被判定器**故意**拒绝的仓库：它们没有语料缓存是设计结果，不是缺口。
 *
 * 质量门槛（Q1 低 star / Q2 低 fork / Q3 README 无示例）与硬拒绝规则
 * （R1 无 SKILL.md、R3 主题无关等）都会让仓库止步于发现阶段。
 * 门槛上线后约 35% 的仓库属于此类 —— 若把它们算进 missing，
 * 审计会**永远**以「覆盖率缺口」失败，把流水线锁死。
 *
 * 判定日志缺失（老缓存 / 未跑判定）时按原逻辑处理，不放宽。
 */
function readSkippedRepos() {
  const file = dir + '/_triage.jsonl'
  if (!fs.existsSync(file)) return null
  const skipped = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (rec?.decision === 'SKIP' && typeof rec.repo === 'string') skipped.add(rec.repo.toLowerCase())
    } catch { /* 单行损坏不应让审计崩掉 */ }
  }
  return skipped.size > 0 ? skipped : new Set()
}
const skipped = readSkippedRepos()

/** 覆盖率必须按「本次发现列表」算，而不是按缓存文件总数 */
const live = new Set(disc.repos.map(r => r.repo))
const rejected = disc.repos.filter(r => skipped?.has(r.repo.toLowerCase()))
const missing = disc.repos.filter(r => !probed.has(r.repo) && !skipped?.has(r.repo.toLowerCase()))
const orphan = [...probed].filter(p => !live.has(p))
/** 覆盖率的分母只算「本该有缓存」的仓库 —— 被拒绝的不参与 */
const expected = live.size - rejected.length
const covered = expected - missing.length

console.log('=== coverage ===')
console.log(
  `covered: ${covered} / ${expected} | missing: ${missing.length}` +
  (skipped ? ` | rejected by gate: ${rejected.length}` : ''),
)
/*
 * 旧写法直接报 `probed.size / disc.repos.length`。但 probed 是**缓存目录里
 * 全部 json 文件**，仓库掉出 star 前 300 后其缓存文件永不清理，
 * 于是 probed 会大于发现列表：实测 336 / 300。
 * 那个 336 里有 36 个是早已不在发现列表的孤儿，把覆盖率算虚高了。
 */
if (orphan.length) {
  console.log(`orphan cache（已不在发现列表，缓存文件残留）: ${orphan.length}`)
  console.log(' ', orphan.slice(0, 15).join(', '))
}
console.log(`cache files on disk: ${files.length}（其中孤儿 ${orphan.length}）`)
for (const r of missing) console.log('  MISS ★' + r.stars, r.repo)

/* 覆盖率缺口要拦住：拿不到内容意味着站点少了这些技能 */
const coverage = expected === 0 ? 1 : covered / expected
if (missing.length > 0) {
  problems.push(
    `覆盖率缺口：${missing.length}/${expected} 个应抓取的仓库没有语料缓存（${(coverage * 100).toFixed(1)}%）`,
  )
}

/* 限流降级：loader 把状态写进了清单，这里程序化读出来 */
console.log('=== build health ===')
try {
  const mf = JSON.parse(fs.readFileSync(dir + '/_manifest.json', 'utf8'))
  console.log(`manifest: count=${mf.count} builtAt=${mf.builtAt} rateLimited=${mf.rateLimited}`)
  if (mf.rateLimited) {
    problems.push('本次构建发生 GitHub 限流降级：站点内容不完整（部分仓库退回旧缓存）')
  }
} catch (e) {
  problems.push(`技能清单不可读：${e.message}`)
}

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
  console.log('=== dist ===')
  /*
   * 技能总数改为从 skills-index.json 读 count 字段。
   *
   * 旧写法用正则 `/全部[\s\S]{0,80}?(\d+)/` 从首页 HTML 里抠数字，
   * 会先撞上导航里的「全部技能」然后匹配到别处的数字 —— 实测抓出来的是
   * `data-astro-cid-zkhec6` 里的 6，把 8,809 个技能报成 6。
   * 这种假指标比没有指标更糟：它看起来像个正常数字，不会引起怀疑。
   */
  const idxPath = root + '/dist/skills-index.json'
  let homeTotal = '?'
  if (fs.existsSync(idxPath)) {
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
    homeTotal = String(idx.count ?? idx.items?.length ?? '?')
    console.log(`skills-index.json: count=${homeTotal} | ${(fs.statSync(idxPath).size / 1e6).toFixed(2)} MB`)
  } else {
    problems.push('dist/skills-index.json 缺失：前端搜索会完全失效')
  }
  console.log(`home total zh: ${homeTotal} | index.html = ${(fs.statSync(root + '/dist/index.html').size / 1e6).toFixed(2)} MB`)

  const tags = fs.readdirSync(root + '/dist/tags')
  console.log('tag pages:', tags.length, '| illegal dirs:', tags.filter(t => /[:*?"<>|#%]/.test(t)).length)
  const sm = fs.readFileSync(root + '/dist/sitemap-0.xml', 'utf8')
  console.log('sitemap urls:', (sm.match(/<loc>/g) || []).length)
  console.log('en skill pages:', fs.readdirSync(root + '/dist/en/skills').length, '| zh skill pages:', fs.readdirSync(root + '/dist/skills').length)
} catch (e) {
  console.log('dist check error', e.message)
  problems.push(`产物检查失败：${e.message}`)
}
console.log('audit done')

/*
 * 以非 0 退出，让 CI 拦住这些情况。
 *
 * 注意 refresh.yml 里这一步是 `npm run audit | tee refresh-audit.txt`，
 * 管道的退出码取自最后一个命令（tee），所以**光设 exitCode 不够**，
 * 工作流那一步还得加 `set -o pipefail`（见该文件）。
 */
if (problems.length) {
  console.error('')
  console.error('=== audit FAILED ===')
  for (const p of problems) console.error('  ✗ ' + p)
  console.error('')
  process.exitCode = 1
} else {
  console.log('audit: 未发现问题')
}
