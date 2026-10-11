---
title: 访谈问题设计
titleEn: Interview Question Designer
description: 按研究目标生成用户访谈提纲：漏斗式问题、追问路径与避坑项。
descriptionEn: Generate user-interview outlines from research goals with funnel questions, follow-up paths and pitfalls.
category: research
tags: [interview, user-research, questions]
grade: A
score: 8.4
likes: 17
ratingUp: 6
added: '2026-09-08'
prompt: |
  请为以下研究目标设计访谈提纲（30-40 分钟）：
  1. 开场与暖场（2 个问题）
  2. 行为层问题（3-4 个，问事实不问观点）
  3. 动机层追问（每个配 1 条追问路径）
  4. 结束与开放问题
  研究目标：{{goal}}，受访对象：{{audience}}
bestFor: 用研新人或需要快速出访谈提纲的 PM。
steps:
  - 写清研究目标与对象
  - 运行得到提纲
  - 自己预演一遍删减问题
  - 访谈后对照提纲检查遗漏
example: |
  行为层：上周最后一次使用 X 的场景？
    追问：当时还考虑过哪些替代？为什么没选？
  动机层：哪个瞬间最不想用？
    追问：如果只能保留一个功能呢？
evaluation: |
  ## 优点
  - 「问事实不问观点」原则内建
  - 追问路径降低新手卡壳
  - 30-40 分钟时长约束

  ## 局限
  - 行业深度问题需专家补充
  - 不替代现场倾听

  ## 总体评价
  访谈提纲的可靠起点，推荐度 4/5。
guide: |
  ## 步骤
  1. 目标越窄提纲越好用
  2. 预演时计时，超了就删
  3. 开场问题避免诱导

  ## 技巧
  - 每个动机问题配 2 条追问路径
  - 结尾开放问题「还有什么我没问到」

  ## 常见问题
  - 问题太抽象：换成「上一次」的具体场景
---

# 访谈问题设计

按研究目标生成用户访谈提纲：漏斗式问题、追问路径与避坑项。

## 何时使用
- 用户研究访谈前出提纲
- 可用性测试的问题设计

## 输入 / 输出
- 输入：研究目标 + 受访对象
- 输出：30-40 分钟访谈提纲（含追问路径）
