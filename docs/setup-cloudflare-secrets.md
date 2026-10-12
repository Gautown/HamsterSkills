# 配置 Cloudflare 凭据并首次部署

本项目需要 3 个 GitHub Actions Secret。这份文档是照着做即可的清单。

---

## 你需要先准备两个值

都在 Cloudflare 后台获取，**我无法代取**（令牌只显示一次）。

### 值一：Account ID

1. 登录 https://dash.cloudflare.com
2. 右侧栏找到 **API 密钥 / API Keys** 区块
3. 复制 **Account ID**（一串 32 位十六进制字符，形如 `a1b2c3d4e5f6...`）

### 值二：API Token

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. 点 **Create Token**
3. 在模板列表里找 **Edit Cloudflare Workers** → 直接用它（它已预填好所需权限）
   - 若没有该模板，点 **Create Custom Token**，权限按下表配置：

   | 权限组 | 权限名 | 范围 |
   | --- | --- | --- |
   | Account | Workers Scripts: **Edit** | 你的账户 |
   | Account | Workers KV Storage: **Edit** | 你的账户 |

   > 范围（Resources）必须选你的账户。若页面要求指定具体 Worker，
   > 选 **包含所有 Workers**（Include all Workers）——首次部署时 Worker 还不存在。

4. 点 Continue to summary → **Create Token**
5. **立刻复制令牌**（形如 `cfut_...`），关掉页面就再也看不到了

> 验证令牌是否有效：
> ```powershell
> curl.exe "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer 你的令牌"
> ```
> 返回 `"status": "active"` 即正常。

---

## 前置条件：域名必须已托管在 Cloudflare

部署时 `wrangler` 会按 `skill.gautown.top` 查找 zone。若该域名的 DNS 不在 Cloudflare，
会直接失败并报 zone 找不到。

打开 https://dash.cloudflare.com 左侧 **Websites** 列表，能看到 `gautown.top` 即满足条件。

---

## 配置 GitHub Actions Secrets

打开：https://github.com/Gautown/HamsterSkills/settings/secrets/actions

点 **New repository secret**，逐个创建（名称必须一字不差）：

| # | Secret 名称 | 填入的值 |
| --- | --- | --- |
| 1 | `CLOUDFLARE_ACCOUNT_ID` | 值一（Account ID） |
| 2 | `CLOUDFLARE_API_TOKEN` | 值二（API Token） |
| 3 | `SITE_URL` | `https://skill.gautown.top` |
| 4 | `AI_API_KEY` | 你的 AI 分类密钥（可选，缺了只跳过 AI 分类） |

> 第 4 个是可选的。它只用于把 8,797 条 skill 按规则+AI 重新分类；
> 不配也能部署，只是分类全部走规则层。

---

## 触发部署

配置完成后有三种触发方式。

### 网页（最简单）

1. https://github.com/Gautown/HamsterSkills/actions
2. 左侧选 **refresh-skills**
3. 右上 **Run workflow** → 分支选 `main` → 点绿色按钮

### 命令行（需 GitHub CLI）

```powershell
gh workflow run refresh.yml --repo Gautown/HamsterSkills
```

### 直接调 API（无需任何额外工具）

```powershell
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
$token = ($cred | Select-String '^password=').ToString().Substring(9)

Invoke-RestMethod -Method Post `
  -Uri "https://api/GitHub.com/repos/Gautown/HamsterSkills/actions/workflows/refresh.yml/dispatches".Replace('GitHub','github') `
  -Headers @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json" } `
  -Body '{"ref":"main"}'
```

---

## 预期结果

```
sync 任务
  ├─ npm run sync         同步 GitHub 技能（约 5 分钟）
  └─ npm run ai-classify  AI 分类（首次约 35 分钟，命中记忆库则很快）

refresh 任务
  ├─ npm run build        构建 20,287 页（约 3 分钟）
  ├─ npm run split        切分 dist-zh / dist-en
  ├─ npm run audit        数据审计
  ├─ npm run deploy:zh    部署中文站 Worker
  └─ npm run deploy:en    部署英文站 Worker
```

部署成功后访问 **https://skill.gautown.top**

---

## 已知风险：sync 任务可能超时

`sync` job 的 `timeout-minutes: 30`，而首次 AI 全量回填约需 35 分钟 —— **大概率会超时中断**。

超时后的影响：
- 已完成的记忆库**不会丢**（脚本每 10 批落盘一次，Actions 也会保存缓存）
- 该次运行标记为失败，但下次运行会接着补

**规避办法**：先在本地跑一次全量回填，缓存会被 Actions 恢复，就不必在 CI 里现算。

```powershell
# 本地设置 AI 密钥（不要提交 .env）
$env:AI_API_KEY = "你的密钥"
npm run ai-classify
```

---

## 排错

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `缺少必要的 Secrets` | Secret 未配置或名称拼错 | 回上表逐个核对名称 |
| `zone not found` / `no zone named` | 域名 DNS 不在 Cloudflare | 先把 `gautown.top` 接入 Cloudflare |
| `Authentication error [code: 10000]` | Token 无效或已过期 | 重新创建 Token，确认勾了 Workers Scripts:Edit |
| `HTTP 404: Not Found` 部署时 | Token 权限不足 | 重建 Token，确认 Account 权限组已勾选 |
| 部署成功但 20,000 文件上限报错 | 免费版静态资产上限 | 见下方说明 |

### 关于静态资产 20,000 上限

Wrangler 免费版每个 Worker 的静态文件数上限是 20,000。本项目实测：

- `dist-zh` 10,152 个文件
- `dist-en` 10,148 个文件

**都在上限内**。若后续 skill 数量增长到上限，会在部署时报错；届时可考虑升级 Workers Paid，或减少标签页数量。

---

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `wrangler.zh.jsonc` | 中文站 Worker 配置（含域名 routes） |
| `wrangler.en.jsonc` | 英文站 Worker 配置 |
| `docs/deploy-cloudflare.md` | 架构说明与成本限额 |
| `.github/workflows/refresh.yml` | 每日同步 + 部署工作流 |