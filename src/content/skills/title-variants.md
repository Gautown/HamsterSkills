---
title: 标题多版本生成
titleEn: Title Variants Generator
description: 为文章或视频一次生成 10 个不同风格的标题，标注适用场景与情绪。
descriptionEn: Generate 10 title variants in different styles for an article or video, with scenario and tone notes.
category: writing
tags: [headline, copywriting, content]
grade: A
score: 8.3
likes: 24
ratingUp: 8
prompt: |
  为以下内容生成 10 个标题，覆盖不同风格：
  - 悬念式 / 数字式 / 对比式 / 痛点式 / 干货式
  每个标题标注：风格 / 适用场景 / 情绪强度（1-5）。
  内容主题：{{topic}}
bestFor: 公众号、视频号、博客作者需要快速做标题 A/B 测试。
steps:
  - 用一句话说清内容主题与受众
  - 运行得到 10 个标题
  - 按平台调性挑 2-3 个候选
  - 小范围 A/B 测试后定稿
example: |
  悬念式：为什么你的周报总被忽略？（场景：公众号，情绪 3）
  数字式：周报只需 10 分钟的 3 个技巧（场景：视频号，情绪 2）
  对比式：同样写周报，有人 10 分钟有人 2 小时（场景：头条，情绪 4）
evaluation: |
  ## 优点
  - 一次覆盖 5 种风格，选择面大
  - 标注场景与情绪，便于匹配平台
  - 适合 A/B 测试工作流

  ## 局限
  - 标题党倾向需人工把关
  - 不替代对平台规则的了解

  ## 总体评价
  标题发散的高效工具，推荐度 4/5。
guide: |
  ## 步骤
  1. 主题描述带上目标受众
  2. 挑 2-3 个候选做 A/B
  3. 记录数据沉淀标题库

  ## 技巧
  - 注明平台（公众号 / 视频号）语气更准
  - 情绪强度 4-5 的标题慎用

  ## 常见问题
  - 标题太夸张：要求「情绪强度 ≤ 3」重新生成
---

# 标题多版本生成

为文章或视频一次生成 10 个不同风格的标题，标注适用场景与情绪。

## 何时使用
- 发布前的标题 A/B 测试
- 同一内容多平台分发时改写标题

## 输入 / 输出
- 输入：内容主题（+ 平台 / 受众）
- 输出：10 个带标注的标题候选
