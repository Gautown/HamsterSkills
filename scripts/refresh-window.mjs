import fs from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * 多配额窗刷新：等配额重置 → 构建（自动探测有变更的远端仓库）→ 汇总一轮结果。
 * 用法：node scripts/refresh-window.mjs <日志前缀> <轮数>
 * 匿名 GitHub API 限额 60 次/小时，全量刷新通常需要 4-5 个窗口（每轮约 1 小时）。
 */
const root = process.cwd()
process.chdir(root)
const logBase = process.argv[2] || 'refresh'
const iters = Number(process.argv[3] || 1)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const stamp = ms => new Date(ms).toLocaleString('sv-SE')

for (let i = 1; i <= iters; i++) {
  const logName = `${logBase}-${i}.log`

  let rem = 0
  let reset = 0
  try {
    const res = await fetch('https://api.github.com/rate_limit', { headers: { 'User-Agent': 'hamster-skills' } })
    const j = await res.json()
    rem = j.resources.core.remaining
    reset = j.resources.core.reset
  } catch (e) {
    console.log(`[${i}] rate_limit fetch failed: ${e.message}`)
    break
  }
  const now = Math.floor(Date.now() / 1000)
  if (rem < 10) {
    const wait = Math.max(30, reset - now + 30)
    console.log(`[${i}] ${stamp(Date.now())} remaining=${rem} -> waiting ${wait}s (reset ~${stamp((reset + 30) * 1000)})`)
    await sleep(wait * 1000)
  } else {
    console.log(`[${i}] ${stamp(Date.now())} remaining=${rem} -> starting build now`)
  }

  let ok = true
  try {
    execSync(`npm run build > .cache/${logName} 2>&1`, { shell: 'cmd.exe' })
    console.log(`[${i}] build exit 0`)
  } catch (e) {
    ok = false
    console.log(`[${i}] build FAILED (exit ${e.status})`)
  }

  const strip = s => s.replace(/\u001b\[[0-9;]*m/g, '')
  let build = ''
  try { build = strip(fs.readFileSync(root + '/.cache/' + logName, 'utf8')) } catch { }
  const bl = build.split(/\r?\n/)
  const built = bl.find(l => l.includes('page(s) built'))
  console.log(`[${i}] built:`, built ? built.trim() : 'NOT FOUND')
  const probeLines = bl.filter(l => /载入 \d+ 个 skill（新拉取 [1-9]/.test(l))
  console.log(`[${i}] probed this run: ${probeLines.length} | rate-limit skips: ${bl.filter(l => l.includes('限额已用尽')).length}`)
  for (const l of probeLines.slice(0, 40)) console.log('   ', l.replace(/^.*\[github-skills\] /, '').slice(0, 130))

  const dir = root + '/.cache/skills-remote'
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_discovery.json')
  let total = 0
  for (const f of files) {
    try { total += Object.keys(JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')).files).length } catch { }
  }
  console.log(`[${i}] cache: repos = ${files.length} | SKILL.md = ${total}`)
  const probedSet = new Set(files.map(f => f.replace(/\.json$/, '').replace('__', '/')))
  const missing = []
  try {
    const disc = JSON.parse(fs.readFileSync(dir + '/_discovery.json', 'utf8'))
    for (const r of disc.repos) if (!probedSet.has(r.repo)) missing.push(r.repo)
    console.log(`[${i}] discovery coverage: ${disc.repos.length - missing.length}/${disc.repos.length} | missing ${missing.length}`)
  } catch { }

  try {
    const home = fs.readFileSync(root + '/dist/index.html', 'utf8')
    const m = home.match(/全部[\s\S]{0,80}?(\d+)/)
    const homeMB = (fs.statSync(root + '/dist/index.html').size / 1e6).toFixed(2)
    console.log(`[${i}] home total zh:`, m ? m[1] : '?', `| index.html = ${homeMB} MB`)
    const idxPath = root + '/dist/skills-index.json'
    if (fs.existsSync(idxPath)) {
      console.log(`[${i}] skills-index.json = ${(fs.statSync(idxPath).size / 1e6).toFixed(2)} MB`)
    } else {
      console.log(`[${i}] skills-index.json MISSING`)
    }
    const tags = fs.readdirSync(root + '/dist/tags')
    console.log(`[${i}] tag pages:`, tags.length, '| illegal dirs:', tags.filter(t => /[:*?"<>|#%]/.test(t)).length)
  } catch (e) {
    console.log(`[${i}] dist check error ${e.message}`)
  }
  console.log(`[${i}] done ${logName} ${ok ? '' : '(build failed)'}`)
}
console.log('refresh-window done')
