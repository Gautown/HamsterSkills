/**
 * 触发前的环境检查：Secrets / Variables / 仓库信息。
 * 通过 Git 凭据调用 REST API（无需 gh CLI）。
 */
import { execSync } from 'node:child_process'

const REPO = 'Gautown/HamsterSkills'
const API = 'https://api.github.com'

/** 用 git 的凭据助手取 token（gh 未安装时的可行路径） */
function getToken() {
  const attempts = [
    'git credential fill',
  ]
  for (const cmd of attempts) {
    try {
      const input = `protocol=https\nhost=github.com\n\n`
      const out = execSync(cmd, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      const m = /^password=(.+)$/m.exec(out)
      if (m) return m[1].trim()
    } catch {
      /* 换下一种方式 */
    }
  }
  return null
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
      'User-Agent': 'hamster-skills-check',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

console.log('=== 仓库 ===')
const repo = await api(`/repos/${REPO}`)
console.log(`  ${repo.body?.full_name} | private=${repo.body?.private} | stars=${repo.body?.stargazers_count}`)

console.log('\n=== 仓库 Secrets（仅名称，值不可读）===')
const secrets = await api(`/repos/${REPO}/actions/secrets`)
if (secrets.status === 200) {
  const names = (secrets.body?.secrets ?? []).map(s => s.name)
  const required = ['AI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SITE_URL']
  for (const n of required) {
    console.log(`  ${names.includes(n) ? '✓' : '✗ 缺失'}  ${n}`)
  }
  console.log(`  全部已配置: ${names.join(', ') || '（无）'}`)
} else {
  console.log(`  查询失败 HTTP ${secrets.status}: ${secrets.body?.message ?? ''}`)
}

console.log('\n=== 仓库 Variables ===')
const vars = await api(`/repos/${REPO}/actions/variables`)
if (vars.status === 200) {
  const items = vars.body?.variables ?? []
  console.log(items.length ? items.map(v => `  ${v.name} = ${v.value}`).join('\n') : '  （未配置，使用默认值）')
} else {
  console.log(`  查询失败 HTTP ${vars.status}: ${vars.body?.message ?? ''}`)
}

console.log('\n=== 最近的工作流运行 ===')
const runs = await api(`/repos/${REPO}/actions/workflows/refresh.yml/runs?per_page=5`)
if (runs.status === 200) {
  const list = runs.body?.workflow_runs ?? []
  if (!list.length) console.log('  （暂无运行记录）')
  for (const r of list) {
    console.log(`  #${r.run_number} ${r.status}/${r.conclusion} ${r.event} ${r.created_at} by ${r.actor?.login}`)
  }
} else {
  console.log(`  查询失败 HTTP ${runs.status}: ${runs.body?.message ?? ''}`)
}

console.log('\n=== Actions 是否启用 ===')
console.log(`  enabled: ${repo.body?.has_issues !== undefined ? '(见下)' : '未知'}`)
const actions = await api(`/repos/${REPO}/actions/permissions`)
console.log(`  ${actions.status === 200 ? JSON.stringify(actions.body) : '查询失败'}`)