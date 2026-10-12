/** 查看最近一次运行的状态与各 job 结论 */
import { execSync } from 'node:child_process'

const REPO = 'Gautown/HamsterSkills'

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
  const res = await fetch(`https://api.github.com${path}`, {
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

const runsRes = await api(`/repos/${REPO}/actions/workflows/refresh.yml/runs?per_page=5`)
const runs = runsRes.body?.workflow_runs ?? []
if (!runs.length) {
  console.log('暂无运行记录')
  process.exit(0)
}

for (const r of runs) {
  console.log(`\n=== #${r.run_number} ${r.status}/${r.conclusion} ===`)
  console.log(`  触发: ${r.event} | 分支: ${r.head_branch} | 提交: ${r.head_sha.slice(0, 7)}`)
  console.log(`  时间: ${r.created_at} → ${r.updated_at}`)
  console.log(`  链接: ${r.html_url}`)

  const jobsRes = await api(`/repos/${REPO}/actions/runs/${r.id}/jobs?per_page=20`)
  for (const j of jobsRes.body?.jobs ?? []) {
    const dur = j.started_at && j.completed_at
      ? `${Math.round((Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000)}s`
      : '—'
    console.log(`\n  job: ${j.name} → ${j.conclusion ?? j.status} (${dur})`)
    for (const s of j.steps ?? []) {
      console.log(`    ${s.conclusion === 'success' ? '✓' : s.conclusion === 'failure' ? '✗' : s.conclusion === 'skipped' ? '-' : '·'} ${s.name}`)
    }
  }
  // 只看最新一次
  break
}