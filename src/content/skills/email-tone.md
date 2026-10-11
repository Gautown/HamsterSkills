---
title: 邮件语气改写
titleEn: Email Tone Rewriter
description: 按目标语气（正式 / 温和 / 坚定 / 友好）改写邮件，保留事实与诉求。
descriptionEn: Rewrite an email in a target tone (formal / warm / firm / friendly) while keeping facts and asks.
category: office
tags: [email, tone, communication]
grade: B
score: 7.8
likes: 13
ratingUp: 4
added: '2026-09-10'
prompt: |
  请将以下邮件改写为{{tone}}语气：
  1. 保留所有事实与诉求，不新增内容
  2. 输出改写后全文
  3. 末尾给出 2 条发送前检查建议
  原邮件：
  {{email}}
bestFor: 对外沟通需要反复拿捏语气的商务、客服与 HR。
steps:
  - 选定目标语气（正式 / 温和 / 坚定）
  - 粘贴原邮件运行
  - 通读检查事实是否被改写
  - 按检查建议微调后发送
example: |
  原：你怎么还没回我？
  改写：您好，想跟您确认一下上周的方案，方便的话今天回复我即可。
  检查：1) 是否保留截止时间 2) 称呼与落款是否一致
evaluation: |
  ## 优点
  - 「保留事实」硬约束降低风险
  - 发送前检查建议实用
  - 语气可选，场景覆盖全

  ## 局限
  - 文化语境差异仍需人判断
  - 超长邮件效果衰减

  ## 总体评价
  对外沟通的安全润色器，推荐度 3.5/5。
guide: |
  ## 步骤
  1. 先定语气再粘贴
  2. 发送前必读检查建议
  3. 重要邮件保留原文档底

  ## 技巧
  - 跨文化沟通注明对方背景
  - 坚定语气要求「不施压但有明确底线」

  ## 常见问题
  - 改写后太软：把诉求句单独标出要求保留
---

# 邮件语气改写

按目标语气改写邮件，保留事实与诉求。

## 何时使用
- 催办 / 投诉 / 谈判前的措辞打磨
- 跨部门、跨文化沟通降噪

## 输入 / 输出
- 输入：原邮件 + 目标语气
- 输出：改写全文 + 发送前检查建议
