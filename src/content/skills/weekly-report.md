---
title: 周报一键生成
titleEn: Weekly Report in One Click
description: 把零散的工作记录整理成结构化周报：进展、风险、下周计划。
descriptionEn: Turn scattered work notes into a structured weekly report with progress, risks and next plans.
category: office
tags: [weekly-report, writing, management]
grade: A
score: 8.8
likes: 35
ratingUp: 11
prompt: |
  请把以下工作记录整理成周报：
  1. 本周进展（按项目分组，标注完成度）
  2. 风险与阻塞（含影响与建议动作）
  3. 下周计划（3-5 条，可衡量）
  语气务实，不夸大。原始记录：
  {{notes}}
bestFor: 每周需要写周报但记录零散的执行者与一线管理者。
steps:
  - 把本周的聊天记录 / 待办完成项粘贴到 {{notes}}
  - 运行 prompt 得到结构化周报
  - 核对进展的完成度数字
  - 补充下周计划后发出
example: |
  进展
  - 落地页改版：已完成 80%，联调中
  - 埋点接入：已完成，数据正常回传

  风险
  - 后端重构延期 3 天，影响下版本排期

  下周计划
  - 完成落地页联调并上线
  - 输出 Q3 数据复盘
evaluation: |
  ## 优点
  - 三段式结构（进展 / 风险 / 计划）符合多数团队要求
  - 语气务实约束减少夸大倾向
  - 原始记录格式自由，容忍度高

  ## 局限
  - 完成度数字需人工核对
  - 不了解团队上下文，风险建议较通用

  ## 总体评价
  周报场景的稳定产出工具，推荐度 4.5/5。
guide: |
  ## 步骤
  1. 周五下午收集本周零散记录
  2. 粘贴运行，人工核对数字
  3. 计划部分控制在 5 条以内

  ## 技巧
  - 平时随手记进展，周五汇总更快
  - 风险项务必写「影响 + 建议动作」

  ## 常见问题
  - 内容太虚：在记录中多写具体交付物
---

# 周报一键生成

把零散的工作记录整理成结构化周报：进展、风险、下周计划。

## 何时使用
- 每周五下班前 10 分钟出周报
- 多项目并行时的进展汇总

## 输入 / 输出
- 输入：零散工作记录（聊天记录 / 待办均可）
- 输出：结构化 Markdown 周报
