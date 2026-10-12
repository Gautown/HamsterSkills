/** 触发前检查：Secrets / Variables / 近期运行 */
import { execSync } from 'node:child_process'

const REPO = 'Gautown/HamsterSkills'
const API = 'https://api.github.com'

function getToken() {
  try {
    const out = execSync('git credential fill', {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const m = /^password=(.+)$/m.exec(out)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

const token = getToken()
if (!token) {
  console.error('无法获取 GitHub 凭据')
  process.exit(2)
}

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hamster-skills',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const REQUIRED = ['AI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SITE_URL']

const secrets = await api(`/repos/${REPO}/actions/secrets`)
const names = secrets.status === 200 ? (secrets.body?.secrets ?? []).map(s => s.name) : []
const missing = REQUIRED.filter(n => !names.includes(n))

console.log('=== Secrets ===')
for (const n of REQUIRED) console.log(`  ${names.includes(n) ? '✓' : '✗ 缺失'}  ${n}`)
if (names.length) console.log(`  已配置: ${names.join(', ')}`)

const vars = await api(`/repos/${REPO}/actions/variables`)
if (vars.status === 200 && vars.body?.variables?.length) {
  console.log('\n=== Variables ===')
  for (const v of vars.body.variables) console.log(`  ${v.name} = ${v.value}`)
}

console.log('\n=== 近期运行 ===')
const runs = await api(`/repos/${REPO}/actions/workflows/refresh.yml/runs?per_page=5`)
const list = runs.status === 200 ? runs.body?.workflow_runs ?? [] : []
if (!list.length) console.log('  （无运行记录）')
for (const r of list) {
  console.log(`  #${r.run_number} ${r.status}/${r.conclusion} ${r.event} ${r.created_at}`)
  if (r.status === 'in_progress' || r.status === 'queued') {
    console.log('    ⚠ 有运行中的实例，再次触发会排队（concurrency 组：refresh-skills）')
  }
}

console.log(`\n=== 结论: ${missing.length === 0 ? '可以触发' : `还缺 ${missing.join(', ')}`} ===`)