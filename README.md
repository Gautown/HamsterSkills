# 仓鼠技能库 · HamsterSkills

按使用功能分类的 AI Skill 目录：中文为主 + `/en` 英文镜像，自动聚合 GitHub 上公开的 Agent Skills 仓库（`<目录>/SKILL.md` 约定），构建为**纯静态站点**，部署在 Cloudflare Workers。

## 特性

- 10 个用途分类 + 1,200+ 标签索引；技能详情页中英双语
- 一键复制 / 导出 `SKILL.md` / 一键安装，评分徽章、点赞与投票
- 自动发现 GitHub 公开仓库（6 个主题并集、按 star 排序），按仓库缓存做**增量同步**
- **双层自动分类**：规则层实时判定 + AI 层按需补正，结果记入记忆库，内容未变则零成本
- 全站**流式聊天窗**（SSE），固定在视口右边缘，能结合当前技能回答
- 首页仅内联前 150 张卡片，全量索引按需加载（首页 HTML < 0.4MB）
- 深色模式、Fluent 2 风格、sitemap/OG 等 SEO 输出
- 部署后由 **Cloudflare Workers Cron 每日定时**触发 GitHub Actions 完成「同步 → 切分 → 审计 → 双站部署」

## 技术栈

Astro 7 · TypeScript · 纯 CSS（Fluent 2）· 无前端框架 · Cloudflare Workers 静态资产

## 本地开发

```bash
npm install
npm run dev            # 开发服务器
npm run build          # 构建（含 GitHub 增量聚合；匿名限额 60 次/小时，全量较慢）
npm run preview        # 预览构建产物
npm run check          # 类型检查（astro check）
npm test               # 单元测试（零依赖、不联网）
npm run audit          # 聚合数据审计（覆盖率 / 生态收录 / 截断仓库）
npm run split          # 切分中英双站资产
```

配 `GITHUB_TOKEN` 后限额提升到 5000 次/小时，全量同步一次即可完成（见 `.env.example`）。

### AI 分类（可选）

`npm run build` 会写出技能清单，随后可跑 AI 分类补正规则层结果：

```bash
npm run build                 # loader 写出 .cache/skills-remote/_manifest.json
npm run ai-classify:dry       # 先看要发多少请求
npm run ai-classify           # 实际调用，结果写入 .cache/ai-classify.json
npm run build                 # 再构建一次，让 AI 分类当次生效
```

未配置 `AI_API_KEY` 时自动跳过，规则层分类照常生效。撞上服务商速率限制时会指数退避并全局冷却，**不会**把批次拆成更多请求去加剧限流。

## 部署与定时更新

见 **[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)**：双 Worker 拆分（规避免费版 20,000 静态资产上限）、GitHub Actions 定时工作流、Cron 触发与手动刷新端点、Secrets 配置与排错。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/classify.md](docs/classify.md) | 规则层分类：10 个分类的判定链路与调参 |
| [docs/ai-classify.md](docs/ai-classify.md) | AI 层分类、记忆库、成本与速率限制处理 |
| [docs/chat.md](docs/chat.md) | 全站聊天窗：SSE 协议、双重限额、上下文注入、回复的 Markdown 渲染与 XSS 防线 |
| [docs/comments.md](docs/comments.md) | Giscus 评论接入 |
| [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md) | 部署与双 Worker 拆分 |
| [docs/setup-cloudflare-secrets.md](docs/setup-cloudflare-secrets.md) | Secrets / Variables 配置清单 |

## 数据来源与合规

技能内容来自 GitHub 公开仓库，遵循各仓库自身的许可；每个技能详情页均标注来源仓库与文件路径链接。聚合逻辑位于 `src/loaders/github-skills.ts`，可用 `SKILLS_*` 环境变量调整发现范围与上限。

## License

GPL-3.0，见 [LICENSE](LICENSE)。