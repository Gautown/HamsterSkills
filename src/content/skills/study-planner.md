---
title: 学习计划制定
titleEn: Study Plan Builder
description: 按目标与可用时间生成周粒度学习计划：任务、里程碑与检验点。
descriptionEn: Build a weekly study plan from goals and available hours, with tasks, milestones and checkpoints.
category: education
tags: [study-plan, learning, productivity]
grade: A
score: 8.5
likes: 26
ratingUp: 8
added: '2026-09-07'
prompt: |
  请制定学习计划：
  1. 每周任务拆解（按可用小时数）
  2. 里程碑（每 2 周一个可检验点）
  3. 每周自检问题（3 个）
  4. 时间不够时的取舍优先级
  目标：{{goal}}，每周可投入：{{hours}} 小时，周期：{{weeks}} 周
bestFor: 备考、学新技能、转行自学需要结构化计划的自学者。
steps:
  - 填目标、每周可用时间、周期
  - 运行得到周计划
  - 每 2 周过一次里程碑检验
  - 未完成按取舍优先级调整
example: |
  W1-2：基础语法 + 50 个核心词（检验：默写 40 个）
  W3-4：简单句对话（检验：录音 3 段 30 秒）
  自检：本周实际学了多久？卡在哪？下周删哪块？
evaluation: |
  ## 优点
  - 可检验点设计让进度可量化
  - 取舍优先级救回拖延的周
  - 自检问题培养复盘习惯

  ## 局限
  - 强度需按个人状态微调
  - 不适合高强度考证冲刺

  ## 总体评价
  自学路径的结构器，推荐度 4/5。
guide: |
  ## 步骤
  1. 目标写成可验收形式（「能 X」）
  2. 可用时间按小时填，别乐观
  3. 检验点未完成就降一档再推

  ## 技巧
  - 与「闪卡生成」配合记忆类目标
  - 每周期末让 AI 重排剩余任务

  ## 常见问题
  - 计划总完不成：把可用时间再打 7 折
---

# 学习计划制定

按目标与可用时间生成周粒度学习计划：任务、里程碑与检验点。

## 何时使用
- 考证 / 学新语言 / 转行自学
- 3-12 周的中短期目标

## 输入 / 输出
- 输入：目标 + 每周小时数 + 周期
- 输出：周计划 + 里程碑 + 自检问题
