---
title: 图表类型推荐
titleEn: Chart Type Recommender
description: 根据数据形态与展示目的推荐合适的图表类型，并说明理由与替代方案。
descriptionEn: Recommend chart types from data shape and communication goal, with rationale and alternatives.
category: data
tags: [visualization, charts, analysis]
grade: B
score: 7.4
likes: 10
ratingUp: 3
added: '2026-09-08'
prompt: |
  请根据以下数据场景推荐图表：
  1. 首选图表类型 + 理由
  2. 两个备选方案（适用什么场景）
  3. 可视化避坑提醒（至少 2 条）
  场景：{{scenario}}，数据维度：{{dimensions}}
bestFor: 做数据汇报、仪表盘与论文图表时选不出图的人。
steps:
  - 写清展示目的（趋势 / 占比 / 分布 / 关联）
  - 运行得到首选 + 备选
  - 按避坑提醒检查现有图表
  - 团队内统一图表规范
example: |
  首选：折线图（展示 12 周趋势，可叠加 3 条对比）
  备选：面积图（强调总量变化）/ 小倍数图（多指标并列）
  避坑：Y 轴不从 0 开始会夸大波动；超过 5 条线改用分面
evaluation: |
  ## 优点
  - 目的驱动推荐，而非堆图表名词
  - 避坑提醒实用（坐标轴 / 数量限制）
  - 备选方案附带适用边界

  ## 局限
  - 不直接出图，需工具落地
  - 审美风格建议有限

  ## 总体评价
  图表选型的好顾问，推荐度 3.5/5。
guide: |
  ## 步骤
  1. 先写「这张图要回答什么问题」
  2. 按首选出图，备选做对照
  3. 汇报前过一遍避坑清单

  ## 技巧
  - 注明工具（ECharts / matplotlib）可给更贴合建议
  - 移动端展示注明屏幕尺寸

  ## 常见问题
  - 图表太丑：在场景里加「极简风格」约束
---

# 图表类型推荐

根据数据形态与展示目的推荐合适的图表类型，并说明理由与替代方案。

## 何时使用
- 数据汇报 / 仪表盘设计前选型
- 现有图表的优化评审

## 输入 / 输出
- 输入：展示目的 + 数据维度
- 输出：首选 + 备选 + 避坑提醒
