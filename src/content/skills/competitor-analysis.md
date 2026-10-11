---
title: 竞品分析框架
titleEn: Competitive Analysis Framework
description: 按定位、功能、定价、渠道、增长、口碑六个维度输出竞品对比矩阵与机会点。
descriptionEn: Run a six-dimension competitor comparison and output a matrix plus actionable opportunities.
category: business
tags: [competitive-analysis, strategy, market]
grade: A
score: 8.2
likes: 18
ratingUp: 6
prompt: |
  按以下维度分析竞品：
  定位 / 核心功能 / 定价模式 / 获客渠道 / 增长策略 / 用户口碑
  输出：
  1. 对比矩阵（Markdown 表格）
  2. 我方 3 条机会点（可执行、可衡量）
  竞品：{{competitors}}
  我方产品：{{product}}
bestFor: 准备版本规划、融资材料的 PM 与战略团队。
steps:
  - 列出 2-4 个核心竞品
  - 填写 {{competitors}} 与 {{product}} 后运行
  - 逐项核对对比矩阵中的事实
  - 将 3 条机会点转成可实验假设
example: |
  对比矩阵
  | 维度 | 竞品 A | 竞品 B | 我方 |
  | 定位 | 企业级 | 个人用户 | SMB |
  | 定价 | 仅年付 | 免费增值 | 月/年订阅 |

  机会点
  1. 竞品 B 无离线支持，下版本试点离线模式
  2. 竞品 A 年付门槛高，可推季度订阅抢中腰部客户
evaluation: |
  ## 优点
  - 六维度（定位 / 功能 / 定价 / 渠道 / 增长 / 口碑）全面
  - 对比矩阵 + 机会点，直接可用于汇报
  - 机会点要求可执行可衡量

  ## 局限
  - 依赖输入信息的准确性
  - 不替代人工尽调

  ## 总体评价
  版本规划 / 融资材料的骨架工具，推荐度 4/5。
guide: |
  ## 步骤
  1. 列出 2-4 个核心竞品
  2. 填写竞品与我方产品后运行
  3. 逐项核对矩阵事实

  ## 技巧
  - 机会点写成「假设 + 验证方式」
  - 定期（季度）重跑对比，跟踪变化

  ## 常见问题
  - 信息不全：先标注「待核实」，不要臆测
---

# 竞品分析框架

按定位、功能、定价、渠道、增长、口碑六个维度输出竞品对比矩阵与机会点。

## 何时使用
- 版本规划前的竞争格局盘点
- 融资材料的竞争章节

## 输入 / 输出
- 输入：竞品列表 + 我方产品
- 输出：对比矩阵 + 3 条机会点
