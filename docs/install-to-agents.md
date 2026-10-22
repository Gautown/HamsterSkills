# 安装到本地 AI 工具（一键安装通道）

详情页右栏的「一键安装」按钮展开安装菜单：每个工具给 **全局 / 项目** 两条可复制命令，
粘进终端即完成安装。本文记录通道选型、命令构建规则与各工具的落盘目录。

## 通道选型

采用 [vercel-labs/skills](https://github.com/vercel-labs/skills) 的官方 CLI：

```
npx skills add <source> [-g] [-a <agent>] -y
```

选它的三个理由：

1. **支持 80+ agent**，`-a` 参数即可把同一个技能装进任意主流工具的目录；
2. **source 直接吃 tree URL**——与本站技能数据里的 `github` 字段
   （`https://github.com/<owner>/<repo>/tree/<branch>/.../<skill-name>`）
   格式完全一致，零转换匹配；也支持 SKILL.md 直链 / ZIP 下载 URL；
3. **官方维护**（Vercel Labs），非第三方拼装。

代价：要求用户本机 **Node.js ≥ 22.20**（`npx` 随 Node 附带）。
菜单里的那句 hint 已注明。

## 安装源决策

| 技能类型 | 安装源 | 理由 |
|---|---|---|
| 远端技能（有 `github` 字段） | 源仓库 tree URL | 装的是上游最新内容，上游更新后重装即可同步 |
| 本地手写技能（无 `github`） | 本站 `/dl/<id>.md` | 没有源仓库，由本站在构建期生成规范 SKILL.md 供 CLI 下载 |

决策逻辑在 `src/lib/install.ts`（`installSourceOf`），纯函数、有单测
（`scripts/install.test.mjs`）。

## `/dl` 下载通道

`src/pages/dl/[id].md.ts` 在构建期对**无 github 字段**的技能逐个产出
`/dl/<id>.md`：

- frontmatter 只保留规范要求的 `name` / `description`
  （`name` = 技能 id，小写连字符 slug；`description` 优先取 `descriptionEn`，
  JSON 字符串转义保证 YAML 安全，超长截断到规范上限 1024 字符）；
- 正文 = SKILL.md 原文 + 本地技能附带的 `## Prompt` 小节（与站内「导出」组装一致）。

端点不进 sitemap、robots 已 `Disallow: /dl/`（原始 md 不该被搜索引擎当正文索引）。

## 各工具对照表

agent 取值与全局目录来自 skills CLI 官方文档（docs/agents.md）。
「全局」= 装到用户目录（`-g`）；「项目」= 装到当前项目目录（不带 `-g`）。

| 菜单标签 | `-a` 取值 | 全局落盘目录 |
|---|---|---|
| OpenCode | `opencode` | `~/.config/opencode/skills/` |
| Claude Code | `claude-code` | `~/.claude/skills/` |
| Codex | `codex` | `~/.agents/skills/` |
| Cursor | `cursor` | `~/.cursor/skills/` |
| VS Code · Copilot | `github-copilot` | `~/.copilot/skills/` |
| Hermes Agent | `hermes-agent` | `~/.hermes/skills/` |
| 其他工具（自动识别） | （省略 `-a`） | CLI 交互式识别当前环境 |

菜单固定提供上表 6 工具 + 通用入口。新增/删改工具时：改 `SkillDetail.astro`
的 `installTools` 数组，agent 取值先查 skills 官方 agents 表，并在
`scripts/install.test.mjs` 的「所有 -a 取值」用例里同步。

## WorkBuddy（手动指引）

WorkBuddy 不在 skills CLI 的 agent 表里（社区实测的 `~/.workbuddy/skills/`
目录未经官方确认），因此菜单不给命令、只给一行**可复制的手动指引**：

> 用「导出」下载 SKILL.md，放入 `~/.workbuddy/skills/<技能id>/` 后重启 WorkBuddy。

点击该 chip 复制的是填好技能 id 的指引文本（i18n key `workbuddyHint`，
占位符 `{name}` 由 `fillPlaceholders` 填充，i18n 测试强制五语言占位符对称）。

## 命令格式

由 `buildInstallCommand` 统一生成，参数顺序固定、`-y` 恒在末位：

```
npx skills add <source> -g -a <agent> -y    # 全局
npx skills add <source> -a <agent> -y       # 项目
npx skills add <source> -g -y              # 通用（自动识别，全局）
```

`-y` 跳过全部交互确认，命令可无头执行。source 是 URL，不含空格，无需引号。

## 局限

- 本机必须能访问 GitHub（远端技能）与本站域名（本地技能）；
- 安装的是技能文件，不会配置目标工具的其他设置（如 MCP）；
- 项目级安装依赖「在目标项目目录下执行」，菜单文案未强调这一点，
  用户装错位置时删除对应目录即可恢复。

## 验证方式

- 单测：`npm test`（`scripts/install.test.mjs` 16 例覆盖命令拼写 / dl frontmatter 边界）
- 线上实测：`npx skills add https://skill.gautown.top/dl/<id>.md --list`
  （CLI 拉取并解析产物，不实际写入；通过即 frontmatter 合规）
