# 部署到 Cloudflare Workers（含每日定时同步）

## 架构

```
Cloudflare Workers（免费版）
├─ hamster-skills-zh  → dist-zh/（中文页 + 资源，含 Worker 脚本）
│    ├─ 静态资产：首页 / 分类 / 标签 / 详情页（约 10.2k 文件）
│    ├─ Cron Trigger：每日 UTC 03:17 → 触发 GitHub Actions
│    └─ POST /api/refresh（Bearer REFRESH_SECRET）手动触发；GET /api/refresh-status 查状态
└─ hamster-skills-en  → dist-en/（英文页，纯静态资产，约 10.2k 文件）

GitHub Actions（refresh.yml，公开仓库免费）
└─ 恢复语料缓存 → npm run build（内含 GitHub 同步）→ 切分双站资产 → 审计 → wrangler deploy ×2 → 保存缓存
```

### 为什么拆成两个 Worker

Workers 免费版每个部署的**静态资产上限是 20,000 个文件**（付费版 100,000）。站点当前约 20,300 个文件（8,900 技能 × 中英 + 标签页），单 Worker 超限。按语言拆成两个 Worker 后各约 10.2k 文件，**零成本保留全部页面与双语 URL**。

## 前置条件

- Cloudflare 账号 + 已托管的域名
- 仓库开启 Actions；准备一个具有 `workflow` 权限的 PAT（用于 Worker 触发 Actions）
- 本地已 `npm run build` 过一次（有 `dist/`）

## Secrets 配置

**GitHub 仓库 → Settings → Secrets and variables → Actions**

| 名称 | 说明 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（Dashboard 右侧可见） |
| `CLOUDFLARE_API_TOKEN` | 具备 Workers Scripts:Edit / Workers KV:Edit 权限的 API Token |
| `SITE_URL` | 站点正式域名，如 `https://skills.example.com`（影响 sitemap/canonical/OG） |

**Worker 端（wrangler secret put）**

```bash
npx wrangler secret put GITHUB_TOKEN -c wrangler.zh.jsonc   # 触发 Actions 用的 PAT
npx wrangler secret put REFRESH_SECRET -c wrangler.zh.jsonc  # 手动刷新端点密钥
```

## 首次部署

```bash
npm install
npm run build                 # 约 5-10 分钟（首次全量同步；配 token 更快）
node scripts/split-assets.mjs # 生成 dist-zh / dist-en 并校验文件数
npx wrangler deploy -c wrangler.zh.jsonc
npx wrangler deploy -c wrangler.en.jsonc
```

部署后先访问 `*.workers.dev` 域名验证，再绑定自定义域名。

## 绑定自定义域名

两个 Worker 需要同一 zone 下的两条路由（**更具体的路径优先**）：

```jsonc
// wrangler.zh.jsonc
"routes": [{ "pattern": "skills.example.com/*", "zone_name": "skills.example.com" }]

// wrangler.en.jsonc
"routes": [{ "pattern": "skills.example.com/en/*", "zone_name": "skills.example.com" }]
```

绑好后设置 `SITE_URL=https://skills.example.com`（Actions Secret），重建一次即可让 sitemap/OG 使用正式域名。

## 定时刷新怎么工作

1. Worker Cron（`17 3 * * *` UTC）→ 调用 GitHub `workflow_dispatch` 触发 `refresh.yml`
2. Actions：恢复语料缓存（`.cache/skills-remote`）→ `npm run build`（loader 依据 `pushedAt` 只拉变更仓库/文件）→ 切分 → 审计 → 部署双 Worker → 保存新缓存
3. `schedule`（`23 3 * * *`）是兜底：GitHub 对公开仓库的定时任务可能排队延迟，故以 Worker Cron 为主

手动触发：

```bash
curl -X POST https://skills.example.com/api/refresh -H "Authorization: Bearer <REFRESH_SECRET>"
curl https://skills.example.com/api/refresh-status
```

## 成本与限额

| 项目 | 免费额度 | 本方案用量 |
| --- | --- | --- |
| Workers 请求 | 100,000/天 | 静态资产直接由资产层响应，仅 `/api/*` 进入 Worker |
| 静态资产文件 | 20,000/版本 | 双站各约 10.2k ✅ |
| Cron | 5 个触发器 | 1 个 |
| GitHub Actions | 公开仓库免费 | 每日 1 次，约 10-20 分钟 |
| GitHub API | 1,000 次/小时（Actions 令牌） | 6 次搜索 + ≤300 次文件树；正文走 raw 不计配额 |

若未来文件数逼近 20,000，可升级 Workers Paid（$5/月，上限 100,000 文件）。

## 排错

| 现象 | 处理 |
| --- | --- |
| 部署报「too many files」 | 运行 `node scripts/split-assets.mjs` 查看两站文件数；超标则升级 Paid 或精简页面 |
| 同步没生效 | 看 Actions 日志的 `probed this run`；为 0 说明仓库无变更（正常）；语料缓存丢失会导致一次全量同步 |
| 构建大量 `HTTP 429` | Actions 令牌限额 1000/时；raw 拉取有重试，通常可自愈 |
| `/api/refresh` 401 | Worker 未设置 `REFRESH_SECRET` 或请求头不符 |
| `/en/*` 404 | 英文 Worker 未部署，或路由模式未加 `/en/*` 前缀 |
| sitemap 仍是占位域名 | 未设置 `SITE_URL` Secret |