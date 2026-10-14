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

助手回复按 Markdown 渲染（见下文「回复的 Markdown 渲染」），气泡容器是 `<div>` 而非 `<p>` —— 回复会渲染出 `ul` / `pre` / `table` 等块级元素，`<p>` 只允许 phrasing content。

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

### 上游限流的处理

上游返回 429 时，Worker 会**等 5 秒自动重试一次**，只有重试仍然失败才告诉用户。

三个设计决定：

**① 只重试 1 次。** 免费档配额本就紧张，多试几次只会把配额桶抽得更干。

**② 网络异常不重试。** 等几秒多半还是连不上，而且 DNS 失败、超时、连接被拒
都不是重试能解决的 —— 重试只是白白消耗一次用户额度。

**③ 两次尝试共用一个超时预算。** 各自拿 60 秒会把请求拖成两分钟；
用同一个 `AbortSignal` 则整个调用（含等待）不超过 60 秒。

### 从上游响应体里取真实原因

早期版本把响应体只打进 `console.error`，用户看到的是写死的「正在限流」——
**那是猜的**。现在由 `parseUpstreamError` 解析出服务商给的原文
（兼容 `{error:{message}}`、`{error:"..."}`、`{message}` 与非 JSON 文本），
再记进日志。目的是能分辨「等 15 秒会好」与「这个原因永远不会好」。

文案**不直接透传**服务商原文：那条原文是中文的、且内容是给站长看的
（「升级 Token Plan 即可解锁」对访客毫无意义），而本站是中英双语站。
所以按状态码分流出各语言的自有文案，只把原文留给日志。

## 双重限额

`/api/chat` 是公开无鉴权端点，不只是聊天窗，任何人都能直接 POST 调用。防护：

| 层 | 默认值 | 配置项 |
|---|---|---|
| 每 IP 每分钟 | 3 条 | `CHAT_RATE_LIMIT` |
| 全站每天 | 200 条 | `CHAT_DAILY_LIMIT` |
| 单条消息 | 2000 字符 | 代码常量 `LIMITS.MAX_MESSAGE_CHARS` |
| 历史条数 | 20 条 | 代码常量 `LIMITS.MAX_HISTORY` |
| 上游限流后重试等待 | 5 秒 | `CHAT_RETRY_DELAY_MS` |

- **每 IP 限流**用 isolate 内内存计数（best-effort，与 `/api/refresh` 同一套写法）。isolate 会重启，所以不是精确计数，但足以挡住随手刷。
- **全站每日额度**用 KV 计数器，按 UTC 日期分键（`chat:YYYY-MM-DD`，48h TTL 自动过期）。KV 全局最终一致，极端并发下可能小幅超出上限 —— 这是兜底而非精确限流。

### 每日额度为什么只有 200

不是随便定的数字，来自对服务商免费档的实测（2026-10-14，`agnes-3.0-flash`，并发 1）：

| 指标 | 实测值 |
|---|---|
| 免费档每窗口放行 | **34 个请求**后开始 429 |
| 从限流到恢复 | **约 14 秒** |
| 成功请求耗时中位 | 7025ms |

上游 429 的响应体原文：

```json
{"error":{"code":"","message":"您已达到免费用户的 API 速率限制。升级 Token Plan 即可解锁更高限额，继续不间断使用 API。","type":"AgnesAI_error"}}
```

要点：

1. 限的是**密钥自身的免费档**，不是 IP 封禁。响应里既没有 `retry-after`
   也没有任何 `x-ratelimit-*` 头。
2. **全站共用这一个密钥**，所有访客的提问都从同一个配额桶里扣。
   原来的 500 条/天 远高于免费档能稳妥支撑的水平，一个高频用户就能把桶抽干，
   让所有人一起看到「服务商限流」。
3. 调低之后，重度用户会先看到「今日提问额度已用完，明天再来」——
   那条提示比「限流，请稍后再试」诚实且可操作。

**局限**：200 条/天 只能压住「单个重度用户长期抽干」的情况。
它**防不住突发** —— 34 个请求的突发额度是瞬时的，两个人同时聊天就可能撞满。
根治只有两条路：升级 Token Plan，或加全局并发闸门（本次未做）。

### 校验顺序（重要）

```
方法 → 密钥 → 每 IP 限流 → 解析并校验请求体 → 只读查每日额度 → 调用 LLM → 成功后计数
```

**每日额度的「检查」必须排在请求体校验之后**，畸形请求（坏 JSON、空内容、超长）
根本不会调用模型，不该占用全站额度 —— 否则一个坏客户端或探测程序就能用垃圾请求
把当天额度耗光。

**而「计数」必须排在调用 LLM 之后。** 早期版本在调用前就 `consumeDailyQuota`，
于是服务商一限流，用户的每日额度就被白扣光 —— 用户什么都没得到，
额度却少了一次。现在拆成 `peekDailyQuota`（只读，不写）与 `commitDailyQuota`
（确认要服务后才写）两步。

> 之所以选「先读后写」而不是「失败后退款」：KV 的读-改-写在并发下会丢更新
> （后写覆盖先写），退款反而可能把计数弄错。

`scripts/chat.test.mjs` 里有对应的回归测试（含一条星标用例专门锁住
「服务商限流不扣额度」）。

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
  "CHAT_DAILY_LIMIT": "200"
}
```

`CHAT_RETRY_DELAY_MS` 可选，不配时用 5 秒。

> 英文站 Worker 是**纯静态无脚本**（没有 `main`），所以 `/en/*` 页面里的
> 聊天窗实际请求的是根路径 `/api/chat`，由中文站的 Worker 处理。
> 好处是限流与额度只有一处；代价是英文站用户会看到中文错误文案。

### KV 绑定

```jsonc
"kv_namespaces": [{ "binding": "CHAT_QUOTA", "id": "..." }]
```

未绑定时自动退化为内存计数，聊天仍可用。

**未配置 `AI_API_KEY` 时端点返回 503「聊天功能尚未配置」**，聊天窗会显示该提示 —— 不会静默失败。

## 回复的 Markdown 渲染

助手回复以 Markdown 渲染（`src/lib/chat-markdown.mjs` 的 `renderChatMarkdown`），
支持粗体 / 斜体 / 删除线 / 行内码 / 列表 / 有序表 / 引用 / 表格 / 代码块，
并把裸 `/skills/<id>/` 变成可点链接 —— `formatHits` 给模型的就是裸路径，
模型会照抄。

**用户气泡仍是纯文本**（`textContent`）：用户输入不需要排版，
也让用户消息无法注入 HTML。

### 为什么模型输出不能直接当 HTML

模型输出进 `innerHTML` 等于变成可执行 HTML，而模型是可被提问诱导的**不可信输入**。
三条防线，缺一条都能被绕过：

1. **原始 HTML 转义** —— 覆盖 `<img onerror>`、`<svg onload>`、`<iframe>`、`<script>`
2. **链接协议白名单** —— 挡 `javascript:` / `data:` / `vbscript:` / `file:`。
   校验前**先剥控制字符**，否则 `java\nscript:alert(1)` 在真实浏览器里是可执行的
   （浏览器解析 URL 时会丢掉 TAB/LF/CR）
3. **图片整体禁用** —— 远端图会把访客 IP 泄露给图床，只保留 alt 文本

危险协议降级为纯文字而非删除，用户仍看得懂模型说了什么。

### 为什么不用「先整体转义再交给 marked」

那样 `&` `<` `>` 全变实体，会把 `> 引用` 直接打死成普通段落（实测输出 `&gt; 引用`）。
必须改写 `renderer` 才能既保留 Markdown 语法又堵住注入。

覆盖 `text` renderer 时还要注意：渲染链接文案期间要关闭链接化，
否则 `[/skills/a/](https://x)` 会产出 `<a>` 套 `<a>`，浏览器会把内层标签拆出外层。

### 懒加载

渲染器约 43KB。聊天窗挂在全站每一页，而绝大多数访客从不点开它，
所以用动态 `import()` 拆成独立 chunk，**首屏新增字节数 = 0**，
只在真的发出第一条消息时才拉。

### 流式渲染节流

模型每秒吐 30~60 个 delta，逐帧重解析整段 Markdown 会反复重排日志区，
肉眼看是气泡高度抖动。节流到 80ms，并在流结束时同步补一次重绘，
保证末尾内容一定落到 DOM。

## 样式作用域的坑

`<style is:global>` —— **整个聊天窗是全局的**，这不是偷懒而是必需：

Astro 默认给 `<style>` 里每个选择器追加 `data-astro-cid-*`，
而聊天窗绝大多数节点是脚本 `createElement` / `innerHTML` 造的，
永远不会有该属性。规则 `.chat-bubble[data-astro-cid-x]` 一条都匹配不上，
气泡会退化成无背景、无边框、无内边距的裸文本（错误气泡连红色都没有）。

块内 61 个选择器全部以 `chat-` / `#chat-` 前缀，无一裸元素或通用类，
放开作用域不影响站内其它组件。加新样式时务必保持这个前缀约定。

## 测试

```bash
node --test scripts/chat.test.mjs           # 54 个用例
node --test scripts/chat-markdown.test.mjs  # 19 个用例
npm test                                    # 全量 145 个
```

不需要真实密钥：LLM 调用通过替换 `globalThis.fetch` 模拟，KV 用内存 Map 替身。

覆盖：入参校验（长度/条数/角色/空内容）、上下文裁剪、限流窗口、每日额度累加与耗尽、畸形请求不扣额度、KV 故障降级、LLM 各错误分支、密钥不出现在请求体中。

Markdown 渲染的 XSS 用例用**标签白名单**判定而非字符串黑名单 ——
黑名单会把已转义文本里的 `onerror=` 字面量误报成危险，误报多了就没人看了。

## 安全要点

- `AI_API_KEY` 只存在于 Worker secret，不进 `vars`、不进仓库、不进任何构建产物
- 前端只与本站 `/api/chat` 通信；响应带 `X-Content-Type-Options: nosniff` 与 `Cache-Control: no-store`
- 助手回复经 `chat-markdown.mjs` 转义后渲染，原始 HTML、危险协议链接、远程图片三条通道全部封堵（见上）
- 用户气泡用 `textContent` 渲染，不接受任何标记
- 第三方技能正文里可能自带示例密钥（如某图片生成技能的 README 写了 `API_KEY = "sk-xxx"`），那是上游仓库的公开内容，不是本站密钥，扫描时需区分
