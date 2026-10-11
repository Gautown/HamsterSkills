# Skill 自动分类（规则层）

聚合进来的远端 skill 没有任何分类信息，需要自动判定归属 10 个分类之一。

## 架构

```
src/lib/classify.mjs          唯一实现（纯函数，无网络依赖）
  ├─ src/loaders/github-skills.ts   构建时调用（站点数据来源）
  └─ scripts/sync-skills.mjs        每日同步时调用（data/skills.json）
```

两处共用同一模块，不存在规则漂移。

## 判定链路

按优先级短路，前一级命中即返回：

| 级别 | 来源 | 置信度 |
| --- | --- | --- |
| 1 | frontmatter 显式 `category:` | 1.0 |
| 2 | `categoryMap` 配置（人工指定） | 0.9 |
| 3 | 路径中的分类目录段（`office/pdf/SKILL.md`） | 0.8 |
| 4 | **关键词打分制** | 最高分/总分 |
| 5 | 兜底 `dev` | 0 |

## 打分制

```
分数 = Σ 命中规则的权重
  目录名命中 → 权重 × 2
  描述/标签命中 → 权重 × 1
取最高分；平分按 TIE_BREAK_PRIORITY 裁决（office > data > design > … > dev）
置信度 = 最高分 / 总分
```

### 为什么目录名权重 ×2

来自 8,797 条真实数据的回放。skill 目录名通常就是功能名（`notion`、`gif`、`recipe`），
信号密度远高于描述；而描述里混入了大量技术栈词汇（`pipeline`、`database`、`frontend`），
那些词描述的是「用什么实现」而非「做什么」。

不区分二者时，`orbit-notion`（Notion 办公集成）会因为描述里的 pipeline/database 被判成 dev。

### 权重的三档设计

| 权重 | 含义 | 例 |
| --- | --- | --- |
| 3 | 分类专属、外行人几乎不会用来描述别的场景 | `figma`、`arxiv`、`recipe` |
| 2 | 相关但常与其它类共现 | `frontend`、`benchmark` |
| 1 | 极易误命中，仅作微调 | `template`、`content`、`tool` |

### 两条硬约束

1. **同一概念不得出现在两个分类里。**
   `sql` / `schema` / `pipeline` 曾同时出现在 `data` 与 `dev`，导致两边得分同时被抬高、
   专有信号反而被压过。现已拆分归属：`pipeline`→dev，`schema`/`sql`→data。

2. **泛化技术词必须压到 1 分。**
   `code` / `api` / `server` / `frontend` / `database` 在任何描述里都可能出现。
   实测这些词曾贡献 dev 近 40% 的得分，把 `orbit-notion`（办公集成）、
   `github-dashboard`（数据看板）、`agent-cost-report`（成本报表）全吸进 dev。

## 效果（8,797 条真实数据回放）

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 关键词全不命中 → 兜底 | 42.8% | **15.1%** |
| dev 占比 | 42.8% | **35.1%** |
| 高置信（≥0.6） | — | 57.2% |
| 中置信（0.35–0.6） | — | 24.4% |
| 低置信（0–0.35） | — | 3.2% |

置信度分布的用途：低置信 + 兜底共 **18.3%**（1,612 条）是留给第二层 AI 分类的输入。

## 测试

```bash
npm run test:classify
```

14 个用例，每条都对应一个真实数据回放中暴露过的实际缺陷（algorithmic-art 被判 dev、
kanban-board 的 "In review" 命中 research、tags 是字符串的仓库导致崩溃等），
防止后续调词时把问题带回来。

## 待办：第二层 AI 分类

规则层已收敛（继续调词的边际收益递减），剩余 18.3% 的低置信条目计划由 LLM 批量分类，
结果回写并记忆化。届时 AI 只需处理规则拿不准的部分，成本可控。