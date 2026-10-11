# 仓鼠技能库 · HamsterSkills

按使用功能分类的 AI Skill 目录：中文为主 + `/en` 英文镜像，自动聚合 GitHub 上公开的 Agent Skills 仓库（`<目录>/SKILL.md` 约定），构建为**纯静态站点**，部署在 Cloudflare Workers。

## 特性

- 10 个用途分类 + 1,200+ 标签索引；技能详情页中英双语
- 一键复制 / 导出 `SKILL.md` / 一键安装，评分徽章、点赞与投票
- 自动发现 GitHub 公开仓库（6 个主题并集、按 star 排序），按仓库缓存做**增量同步**
- 首页仅内联前 150 张卡片，全量索引按需加载（首页 HTML < 0.4MB）
- 深色模式、Fluent 2 风格、sitemap/OG 等 SEO 输出
- 部署后由 **Cloudflare Workers Cron 每日定时**触发 GitHub Actions 完成「同步 → 构建 → 部署」

## 技术栈

Astro 7 · TypeScript · 纯 CSS（Fluent 2）· 无前端框架 · Cloudflare Workers 静态资产

## 本地开发

```bash
npm install
npm run dev       # 开发服务器
npm run build     # 构建（含 GitHub 同步；匿名 API 限额 60 次/小时，全量同步较慢）
npm run preview   # 预览构建产物
npm run check     # 类型检查（astro check）
npm run audit     # 聚合数据审计（覆盖率 / 生态收录 / 截断仓库）
```

配 `GITHUB_TOKEN` 后限额提升到 5000 次/小时，全量同步一次即可完成（见 `.env.example`）。

## 部署与定时更新

见 **[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)**：双 Worker 拆分（规避免费版 20,000 静态资产上限）、GitHub Actions 定时工作流、Cron 触发与手动刷新端点、Secrets 配置与排错。

## 数据来源与合规

技能内容来自 GitHub 公开仓库，遵循各仓库自身的许可；每个技能详情页均标注来源仓库与文件路径链接。聚合逻辑位于 `src/loaders/github-skills.ts`，可用 `SKILLS_*` 环境变量调整发现范围与上限。

## License

GPL-3.0，见 [LICENSE](LICENSE)。