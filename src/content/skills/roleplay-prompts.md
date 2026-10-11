---
title: 角色扮演提示词
titleEn: Roleplay Prompt Kits
description: 按角色与场景生成角色扮演提示词包：人设、说话规则、示例对话与出戏保护。
descriptionEn: Generate roleplay prompt kits with persona, speech rules, sample dialogue and out-of-character safeguards.
category: prompting
tags: [roleplay, character, creative]
grade: A
score: 8.9
likes: 35
ratingUp: 12
files:
  - SKILL.md
  - templates/persona.md
  - templates/guardrails.md
added: '2026-09-05'
prompt: |
  为角色「{{character}}」生成角色扮演提示词包：
  1. 人设卡（身份 / 背景 / 目标 / 性格 4 项）
  2. 说话规则（口癖 / 禁忌用语 / 节奏）
  3. 3 段示例对话（含情绪转折）
  4. 出戏保护（用户要求跳出角色时的回应模板）
  场景：{{scene}}
bestFor: 做虚拟角色、客服模拟、故事共创与学习陪练的 prompt 作者。
steps:
  - 写清角色与使用场景
  - 运行得到提示词包
  - 用示例对话自检人设一致性
  - 按实际出戏情况补 guardrails
example: |
  人设：35 岁老船长，务实，惜字
  规则：单句 ≤ 12 字；不用现代词；雨天话多
  示例：「风大了。」「先收帆，别的回头说。」
  出戏保护：「（跳出）我是 AI，需要我改设定吗？」
evaluation: |
  ## 优点
  - 四件套完整（人设 / 规则 / 示例 / 保护）
  - 示例带情绪转折，便于验收
  - 出戏保护可定制

  ## 局限
  - 长对话人设漂移仍需定期纠偏
  - 复杂世界观需拆多个包

  ## 总体评价
  角色类 prompt 的脚手架，推荐度 4/5。
guide: |
  ## 步骤
  1. 先定 4 项人设再说话规则
  2. 示例对话覆盖 2 种情绪
  3. 每次长对话后要求「人设自检」

  ## 技巧
  - 口癖是最有效的角色锚
  - 与「提示词评审」组合把包入库

  ## 常见问题
  - 角色太 OOC：把禁忌语写得具体（列 5 条）
---

# 角色扮演提示词

按角色与场景生成角色扮演提示词包：人设、说话规则、示例对话与出戏保护。

## 何时使用
- 虚拟角色 / 客服模拟 / 故事共创
- 学习陪练（如外语对话）

## 输入 / 输出
- 输入：角色 + 场景
- 输出：提示词包（人设 / 规则 / 示例 / 保护）
