/**
 * 中文站 Worker 入口：
 * - 静态资产由 assets binding 直接服务（run_worker_first 只放行 /api/*）
 * - Cron Trigger：每日触发 GitHub Actions 的 refresh 工作流（同步 GitHub → 构建 → 部署）
 * - POST /api/refresh：手动触发（需 Bearer REFRESH_SECRET）
 * - GET  /api/refresh-status：查询最近一次刷新工作流状态
 *
 * 所需 Secrets（wrangler secret put）：
 *   GITHUB_TOKEN    具有 workflow 权限的 PAT（触发 Actions 用）
 *   REFRESH_SECRET  手动刷新端点的共享密钥
 * Vars（wrangler.jsonc）：
 *   GITHUB_REPO     形如 owner/repo
 */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  GITHUB_REPO?: string
  GITHUB_TOKEN?: string
  REFRESH_SECRET?: string
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void
}

interface CronEvent {
  cron?: string
  scheduledTime?: number
}

const GITHUB_API = 'https://api.github.com'
const WORKFLOW_FILE = 'refresh.yml'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function dispatchRefresh(env: Env, reason: string): Promise<Response> {
  const repo = env.GITHUB_REPO
  const token = env.GITHUB_TOKEN
  if (!repo || !token) return json({ ok: false, error: '缺少 GITHUB_REPO / GITHUB_TOKEN' }, 500)
  const res = await fetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'hamster-skills-worker',
    },
    body: JSON.stringify({ ref: 'main' }),
  })
  if (!res.ok) return json({ ok: false, reason, status: res.status, body: await res.text() }, 502)
  return json({ ok: true, reason, dispatchedAt: new Date().toISOString() })
}

async function refreshStatus(env: Env): Promise<Response> {
  const repo = env.GITHUB_REPO
  const token = env.GITHUB_TOKEN
  if (!repo || !token) return json({ error: '缺少 GITHUB_REPO / GITHUB_TOKEN' }, 500)
  const res = await fetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hamster-skills-worker' },
  })
  if (!res.ok) return json({ error: res.status }, 502)
  const data = (await res.json()) as { workflow_runs?: Array<Record<string, unknown>> }
  const run = data.workflow_runs?.[0]
  return run
    ? json({ status: run.status, conclusion: run.conclusion, createdAt: run.created_at, url: run.html_url })
    : json({ runs: 0 })
}

function authorized(request: Request, env: Env): boolean {
  const secret = env.REFRESH_SECRET
  if (!secret) return false
  return request.headers.get('Authorization') === `Bearer ${secret}`
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/refresh') {
      if (request.method !== 'POST') return json({ error: '仅支持 POST' }, 405)
      if (!authorized(request, env)) return json({ error: '未授权' }, 401)
      return dispatchRefresh(env, 'manual')
    }
    if (pathname === '/api/refresh-status') return refreshStatus(env)
    return env.ASSETS.fetch(request)
  },

  async scheduled(_event: CronEvent, env: Env, ctx: Ctx): Promise<void> {
    ctx.waitUntil(dispatchRefresh(env, 'cron').then(() => undefined))
  },
}