# 每日技能同步（sync-skills）

独立同步脚本：从 GitHub 发现并拉取 Agent Skills，按 **skill id 覆盖**写入 `data/skills.json`。

## 用法

```bash
npm run sync         # 正常同步（增量）
npm run sync:dry     # 只统计将发生的变化，不写文件
npm run sync:force   # 忽略增量判定，强制重扫全部目标仓库
```

## 行为

1. **发现**：6 个主题检索 GitHub → 按 star 降序取前 N 仓（默认 300）；发现缓存 24 小时有效
2. **增量判定**：仓库 `pushedAt` 未变且缓存完整 → **0 次 API 请求**直接复用
3. **拉取**：仅下载新增或内容变更的 `SKILL.md`（`raw.githubusercontent.com` 不消耗 API 配额）
4. **合并**：以 **skill id**（`slugify(目录名)`）为唯一键
   - 新 id → **新增**
   - 同 id、同仓库、内容 sha 变化 → **覆盖**
   - 同 id、不同仓库 → 保留高星仓库（先遍历到的），低星仓库丢弃（与站点现有 URL 体系一致）
5. **产出**：`data/skills.json`（原子写：临时文件 + rename）

## 数据格式

```jsonc
{
  "version": 1,
  "syncedAt": "2026-10-11T06:48:41.622Z",
  "count": 8797,
  "repos": 300,
  "skills": [
    {
      "id": "canvas-design",
      "repo": "Prat011/awesome-llm-skills",
      "path": "canvas-design/SKILL.md",
      "sha": "…",
      "data": { "title": "…", "titleEn": "…", "description": "…", "descriptionEn": "…",
                "category": "office", "tags": [], "github": "https://github.com/…", "author": "Prat011" },
      "body": "# 正文…"
    }
  ]
}
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 空 | 匿名 60 次/时；配置后 5000 次/时，强烈建议 |
| `SKILLS_TOPICS` | 6 个主题 | 逗号分隔 |
| `SKILLS_MAX_REPOS` | 300 | 发现仓库上限 |
| `SKILLS_MAX_SKILLS_PER_REPO` | 200 | 单仓 skill 上限 |
| `SKILLS_MAX_SKILLS` | 12000 | 合并后总量上限 |
| `SKILLS_DISCOVER_TTL_HOURS` | 24 | 发现缓存时长 |
| `GITHUB_API_BASE` / `GITHUB_RAW_BASE` | 官方地址 | 镜像或企业版时覆盖 |

## 每日自动执行

`.github/workflows/refresh.yml` 的 `sync` 任务：每日定时（UTC 03:23）+ 支持手动 `Run workflow`，
执行 `npm run sync`，恢复/保存语料缓存（增量关键），并把 `data/skills.json` 作为 artifact 上传。

## 与站点构建的关系

脚本负责**数据层**同步；站点页面由 `npm run build` 生成并在构建时读取这些数据。
`data/` 已在 `.gitignore` 中（每次同步重新生成），需要长期留存时用 artifact 或把 `.cache/skills-remote/` 一并缓存。