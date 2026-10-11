---
title: 提示词评审
titleEn: Prompt Critique
description: 评审一段提示词的质量：清晰度、完整性、可测试性，并给出改进版本。
descriptionEn: Review a prompt for clarity, completeness and testability, then output an improved version.
category: prompting
tags: [prompt-engineering, review, quality]
grade: S
score: 9.3
likes: 40
ratingUp: 13
files:
  - SKILL.md
  - templates/rubric.md
  - templates/improved.md
prompt: |
  请评审以下提示词，按四个维度打分（1-5）并给出改进版：
  1. 角色与目标是否明确
  2. 上下文是否充分
  3. 约束与输出格式是否可测试
  4. 示例是否具体
  待评审提示词：
  {{prompt}}
bestFor: 维护团队 prompt 模板库、需要统一质量标准的 prompt 工程师。
steps:
  - 粘贴待评审的提示词到 {{prompt}}
  - 运行得到四维评分与改进版
  - 对照改进版修订原 prompt
  - 入库时附评分记录
example: |
  角色与目标 4/5：角色明确，但缺少成功标准
  上下文 3/5：未说明目标平台
  可测试性 2/5：输出格式无校验点
  示例 1/5：无示例

  改进版：见下（略）
evaluation: |
  ## 优点
  - 四维评分卡可复用为入库门槛
  - 直接输出改进版，闭环
  - 适合团队模板库的质量评审

  ## 局限
  - 评分有主观成分，需结合实测
  - 不评估实际模型表现

  ## 总体评价
  prompt 质量门禁的实用工具，推荐度 4.5/5。
guide: |
  ## 步骤
  1. 新 prompt 入库前先跑评审
  2. 任一维度 < 3 分需返工
  3. 评审记录随模板一起存档

  ## 技巧
  - 与「提示词结构化整理」组合使用
  - 团队共用同一评分卡便于对齐

  ## 常见问题
  - 评分忽高忽低：补充具体评分锚点示例
---

# 提示词评审

评审一段提示词的质量：清晰度、完整性、可测试性，并给出改进版本。

## 何时使用
- prompt 模板入库前的质量门禁
- 评审存量 prompt 找出低质量项

## 输入 / 输出
- 输入：待评审提示词
- 输出：四维评分 + 改进版
