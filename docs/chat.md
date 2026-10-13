# 站内聊天窗

全站悬浮聊天窗，后端代理 `agnes-3.0-flash`，回答站点答疑与技能推荐。

## 为什么必须有后端

站点是**全静态**的。`AI_API_KEY` 一旦写进前端 JS，任何人查看网页源代码就能拿走。

因此浏览器**不直连 LLM**，只与本站 `POST /api/chat` 通信，由中文站 Worker 持密钥调用模型：

```
浏览器 ──POST /api/chat──▶ hamster-skills-zh Worker ──▶ LLM
                              （持 AI_API_KEY）
```

中英双站共用这一个端点 —— 英文页面的 `/api/chat` 与页面同源，会落到中文站 Worker（英文站 Worker 是纯资产，没有 `main`）。

`wrangler.zh.jsonc` 里 `assets.run_worker_first: ["/api/*"]` 已放行 `/api/*` 进 Worker，其余请求由静态资产层直接响应。

## 位置与交互

| | |
|---|---|
| 位置 | 视口**右边缘、垂直居中**：`position:fixed; right:0; top:50%; transform:translateY(-50%)` |
| 展开 | 点击后面板向左展开（`margin-right` 让出按钮位置），不覆盖页面主体阅读区 |
| 窄屏 | ≤560px 降级到右下角，面板占满可用宽度 |
| 打印 | `@media print` 隐藏 |
| 动效 | 尊重 `prefers-reduced-motion` |

按钮与面板同属 `.chat-dock`，整体居中，两者的相对位置不会漂移。

交互细节：Enter 发送 / Shift+Enter 换行 / 输入框随内容增高至 5 行封顶 /「思考中」三点动画（收到首个 delta 后被真实内容气泡替换）/ Esc 收起。

额度被拒绝（429）时才丢弃对话历史 —— 配额是全局的、短期内不会恢复；网络抖动或模型异常则保留历史，用户很可能只是想让模型把刚才那句答完。

无障碍：`aria-expanded` 随展开状态同步、`aria-live="polite"`、两个图标交叉淡入淡出（不换 DOM）。

## 技能上下文注入

技能详情页通过 `Layout` 的 `skill` prop 传入当前技能信息，组件序列化到 `data-skill`，随请求发给 Worker，Worker 拼进系统提示。

```astro
<!-- src/pages/skills/[slug].astro -->
<Layout skill={{ id: entry.id, title: entry.data.title, category: entry.data.category, description: entry.data.description }}>
```

非技能页（首页、分类页、标签页、404）不带上下文。

系统提示把模型约束在「仓鼠技能库助手」范围内，并明确要求：

> 如果用户问某个具体技能而你不能确定是否存在，就直说「站内可以搜索 XXX」，不要编造技能名或仓库地址

这条约束是必要的 —— **模型看不到完整的技能清单**，只注入了当前页面的那一条。

## 响应协议（SSE 流式）

`POST /api/chat` 返回 `text/event-stream`，每个事件一行 `data: JSON`：

| 事件 | 时机 | 载荷 |
|---|---|---|
| `meta` | 首帧 | `{model, dailyUsed, dailyLimit}` |
| `delta` | 任意多次 | `{text}` 增量文本 |
| `error` | 流中途失败 | `{message}` |
| `done` | 结束 | `{}` |

`meta` 帧里的额度字段前端**不展示**（用户不需要看到剩余次数），
但协议里保留，便于将来要做用量统计时无需改后端。

响应头：`Cache-Control: no-cache, no-transform`（禁止中间层缓冲）、`X-Accel-Buffering: no`、`X-Content-Type-Options: nosniff`。

### 为什么要重新封装，而不是裸管道

1. **流开始后响应头已发出，无法再改 HTTP 状态码。** 上游中途断线只能靠 `error` 事件告知前端，否则用户会以为模型答完了。
2. **额度用量随首帧下发**（HTTP 头此时也已发出）。
3. **不把上游的 chunk 结构暴露给前端**，将来换供应商时前端不用改。

因此**流开始之前的失败**（403 / 405 / 429 / 400 / 503）仍返回普通 JSON，前端据此显示可读的错误文案；只有进入流式之后才改用 `error` 事件。

### 上游帧重组的两个坑

- **一帧可能跨多个 TCP 包**：必须保留 `buffer` 残块，不能 `split('\n')` 后丢弃。
- **UTF-8 多字节字符可能被切断**：必须用 `TextDecoder.decode(value, {stream: true})`，去掉 `stream: true` 会把中文变成乱码。

两者都有对应的单元测试（逐字节拆分、帧跨 chunk、`[DONE]` 缺失、上游抛错、坏帧跳过）。

实测：36 个 delta 帧逐段到达，**1680ms 出首字 → 5005ms 完成**（非流式时用户要干等 5 秒）。

## 双重限额

`/api/chat` 是公开无鉴权端点，不只是聊天窗，任何人都能直接 POST 调用。防护：

| 层 | 默认值 | 配置项 |
|---|---|---|
| 每 IP 每分钟 | 3 条 | `CHAT_RATE_LIMIT` |
| 全站每天 | 500 条 | `CHAT_DAILY_LIMIT` |
| 单条消息 | 2000 字符 | 代码常量 `LIMITS.MAX_MESSAGE_CHARS` |
| 历史条数 | 20 条 | 代码常量 `LIMITS.MAX_HISTORY` |

- **每 IP 限流**用 isolate 内内存计数（best-effort，与 `/api/refresh` 同一套写法）。isolate 会重启，所以不是精确计数，但足以挡住随手刷。
- **全站每日额度**用 KV 计数器，按 UTC 日期分键（`chat:YYYY-MM-DD`，48h TTL 自动过期）。KV 全局最终一致，极端并发下可能小幅超出上限 —— 这是兜底而非精确限流。

### 校验顺序（重要）

```
方法 → 密钥 → 每 IP 限流 → 解析并校验请求体 → 每日额度 → 调用 LLM
```

**每日额度必须排在请求体校验之后。** 畸形请求（坏 JSON、空内容、超长）根本不会调用模型，不该占用全站额度 —— 否则一个坏客户端或探测程序就能用垃圾请求把当天额度耗光。每 IP 限流已经挡住了这类洪泛。

`scripts/chat.test.mjs` 里有对应的回归测试。

### KV 故障时

降级为 isolate 内内存计数，**而不是拒绝服务** —— 聊天功能可用性优先于额度精确性。

## 配置

### Secret（绝不能进仓库）

```powershell
npx wrangler secret put AI_API_KEY --config wrangler.zh.jsonc
```

与 GitHub Actions 里的 `AI_API_KEY` 可以是同一个值（用途不同：Actions 跑批量分类，Worker 跑在线对话），但两处都要单独配置。

### Vars（`wrangler.zh.jsonc`）

```jsonc
"vars": {
  "GITHUB_REPO": "Gautown/HamsterSkills",
  "AI_API_BASE": "https://api.agnes-ai.cn/v1",
  "AI_MODEL": "agnes-3.0-flash",
  "CHAT_RATE_LIMIT": "3",
  "CHAT_DAILY_LIMIT": "500"
}
```

### KV 绑定

```jsonc
"kv_namespaces": [{ "binding": "CHAT_QUOTA", "id": "..." }]
```

未绑定时自动退化为内存计数，聊天仍可用。

**未配置 `AI_API_KEY` 时端点返回 503「聊天功能尚未配置」**，聊天窗会显示该提示 —— 不会静默失败。

## 测试

```bash
node --test scripts/chat.test.mjs    # 43 个用例
npm test                            # 全量 68 个
```

不需要真实密钥：LLM 调用通过替换 `globalThis.fetch` 模拟，KV 用内存 Map 替身。

覆盖：入参校验（长度/条数/角色/空内容）、上下文裁剪、限流窗口、每日额度累加与耗尽、畸形请求不扣额度、KV 故障降级、LLM 各错误分支、密钥不出现在请求体中。

## 安全要点

- `AI_API_KEY` 只存在于 Worker secret，不进 `vars`、不进仓库、不进任何构建产物
- 前端只与本站 `/api/chat` 通信；响应带 `X-Content-Type-Options: nosniff` 与 `Cache-Control: no-store`
- 消息气泡用 `textContent` 渲染，模型输出不会被当作 HTML 执行
- 第三方技能正文里可能自带示例密钥（如某图片生成技能的 README 写了 `API_KEY = "sk-xxx"`），那是上游仓库的公开内容，不是本站密钥，扫描时需区分
