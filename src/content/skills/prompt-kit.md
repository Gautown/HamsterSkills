---
title: 提示词结构化整理
titleEn: Prompt Structuring Kit
description: 把口语化需求改写为结构化提示词：角色、任务、背景、约束、输出格式、示例。
descriptionEn: "Rewrite casual requests into structured prompts: role, task, context, constraints, format, examples."
category: prompting
tags: [prompt-engineering, templates]
grade: A
score: 8.7
likes: 31
ratingUp: 11
files:
  - SKILL.md
  - templates/six-part.md
  - templates/rewrite.md
prompt: |
  请把下面的需求改写为结构化提示词，包含：
  角色 / 任务 / 背景 / 约束 / 输出格式 / 示例
  改写后给出 1-2 句改进说明。
  原始需求：
  {{raw}}
bestFor: 想把模糊需求改写成高效结构化 prompt 的人，可作为通用「prompt 润色器」。
steps:
  - 用一句话写下原始需求
  - 粘贴到 {{raw}} 位置运行
  - 检查六要素（角色/任务/背景/约束/格式/示例）是否齐全
  - 投入实际任务使用，并沉淀为模板库条目
example: |
  原始：帮我写封邮件
  改写后：
  角色：企业事务专员
  任务：向合作伙伴写延期通知邮件
  约束：200 字以内，语气正式但友好，包含新时间表
  输出格式：主题行 + 正文，不用表情符号
evaluation: |
  ## 优点
  - 六要素（角色 / 任务 / 背景 / 约束 / 格式 / 示例）齐全
  - 附改进说明，可学习改写思路
  - 沉淀为模板库即可复用

  ## 局限
  - 输出质量受原始需求信息量限制
  - 复杂任务仍需人工补充背景

  ## 总体评价
  通用 prompt 润色器，推荐度 4/5。
guide: |
  ## 步骤
  1. 一句话写下原始需求
  2. 运行得到结构化 prompt
  3. 检查六要素是否齐全

  ## 技巧
  - 好的改写 = 补充了模型缺的背景信息
  - 把高频改写结果存为个人模板

  ## 常见问题
  - 改写后跑偏：把「示例」要素填成真实案例
---

# 提示词结构化整理

把口语化需求改写为结构化提示词：角色、任务、背景、约束、输出格式、示例。

## 何时使用
- 把「帮我写个邮件」这类模糊需求变高效
- 沉淀团队 prompt 模板库

## 输入 / 输出
- 输入：原始需求（一句话即可）
- 输出：结构化 prompt + 改进说明
