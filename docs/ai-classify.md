# AI 分类（第二步）

规则层（[classify.md](./classify.md)）对低置信条目容易判错，这一层用 LLM 兜底。

## 架构

```
scripts/ai-classify.mjs         调用 LLM，产出分类结果
        ↓
.cache/ai-classify.json         记忆库：{ "<skillId>": { sha, category, at, tokens } }
        ↓                      （由 .gitignore 忽略，但 Actions 缓存会保留）
   ┌────┴────┐
   ↓         ↓
loader    sync-skills
（构建时）  （每日同步时）
```

**记忆库是这一层的核心设计。** 站点页面由 `astro build` 通过 loader 产出，而 AI 分类跑在 sync 之后。
若把结果只写进 `data/skills.json`，站点根本看不到。所以结果落在记忆库里，
loader 与同步脚本在分类时都会优先查它——一次 AI 分类，两边同时生效，**无需改动任何站点代码**。

### 记忆化为什么用「skill id + 内容 sha」

- 内容没变（sha 相同）→ 直接复用历史结果，**零 token**
- 上游改了 `SKILL.md`（sha 变化）→ 视为无缓存，重新判定

这让成本只随**新增和变更**增长，而不是随总量增长。

## 用法

```bash
npm run ai-classify          # 处理所有未记忆化的条目
npm run ai-classify:dry      # 只统计将发起多少请求，不调用
npm run ai-classify:status   # 查看记忆库统计与分类分布
node scripts/ai-classify.mjs --limit 50            # 本次最多处理 50 条
node scripts/ai-classify.mjs --concurrency 5       # 提高并发
```

未配置 `AI_API_KEY` 时脚本直接跳过并返回，规则层分类照常生效。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AI_API_KEY` | 空 | 必填才能运行；未配置则跳过 |
| `AI_API_BASE` | `https://api.agnes-ai.cn/v1` | OpenAI 兼容端点 |
| `AI_MODEL` | `agnes-3.0-flash` | 可选 `agnes-2.5-flash/pro` |

## 实测得出的三个关键参数

这些取值不是猜的，是对目标接口实测后确定的：

| 参数 | 取值 | 原因 |
| --- | --- | --- |
| **不传 `response_format`** | — | 该模型在 `json_object` 模式下会忽略「输出数组」要求，只返回单个对象，导致 20 条请求只解析出 1 条。不传时 20/20 正常 |
| `max_tokens` | 1600 | 20 条分类实测需约 1000 tokens；设成 900 会被截断成空字符串 |
| `temperature` | 0 | 保证同样输入得到同样输出，分类可复现 |
| 批量 | 20 条/请求 | 实测 20 条 100% 合法，40 条时单请求延迟波动明显变大 |
| 并发 | 3 | 实测 5 并发时出现单请求 24s 的长尾 |

## 失败降级

```
批量请求失败 → 拆成单条重试（最多两轮）
单条仍失败  → 跳过该条，保留规则层结果
全部失败    → exit 1（但不会阻塞站点构建，workflow 里配了 continue-on-error）
```

无论 AI 是否可用，站点都能正常构建——最差情况就是退回规则层分类。

## 成本（80 条真实低置信样本实测）

| 指标 | 数值 |
| --- | --- |
| 平均成本 | ~50 tokens/条 |
| 批次成功率 | 4/4 批次，80/80 分类全部合法 |
| 全量 8,797 条首次回填 | 440 请求 / ~440k tokens / 并发 3 约 35 分钟 |
| 日常运行（记忆库已建立） | **0 请求** |
| 内容变更的条目 | 按变更量计费，约 20 条/天 ≈ 1k tokens |

## CI

`.github/workflows/refresh.yml` 的 `sync` 任务在 `npm run sync` 之后自动执行：

```yaml
- name: AI 分类（记忆库命中的条目零成本，内容变更才重新调用）
  run: npm run ai-classify | tee ai-output.txt
  continue-on-error: true
```

记忆库文件已加入 Actions 缓存的 path 列表，因此**每天只有真正的新增/变更条目会产生费用**。

### Secrets 配置

| 名称 | 类型 | 必需 |
| --- | --- | --- |
| `AI_API_KEY` | Secret | 是（缺失则跳过 AI，用规则层分类） |
| `AI_API_BASE` | Variable | 否，默认官方地址 |
| `AI_MODEL` | Variable | 否，默认 `agnes-3.0-flash` |

## 测试

```bash
node --test scripts/ai-cache.test.mjs   # 记忆库读写、原子性、sha 失效
```

## 安全

密钥只从环境变量读取，代码与文档中均无硬编码。`.env` 已在 `.gitignore` 中。
若曾把密钥提交进公开仓库，需立即在服务商后台吊销并重新生成。