---
title: 长文摘要生成器
titleEn: Long-form Summarizer
description: 把长文压缩成 3 级摘要：一句话、要点清单、深度总结，按需取用。
descriptionEn: "Compress a long document into three summary levels: one-liner, bullet points, and deep digest."
category: writing
tags: [summary, information, reading]
grade: A
score: 8.7
likes: 28
ratingUp: 9
added: '2026-09-09'
prompt: |
  请把以下长文压缩为三级摘要：
  1. 一句话摘要（≤ 40 字）
  2. 要点清单（5-7 条，每条 ≤ 20 字）
  3. 深度总结（≤ 200 字，含结论与影响）
  长文：
  {{text}}
bestFor: 需要快速消化长文、纪要、报告与论文正文的读者。
steps:
  - 粘贴全文到 {{text}}
  - 按场景取用一级（扫一眼）或三级（写评论）
  - 关键结论人工回查原文
  - 归档要点到自己的知识库
example: |
  一句话：该方案以懒加载降低 token 消耗 62%，成功率不变。
  要点：分块策略 / 懒加载 / 4 阶段评估 / 中文仓库未验证...
  深度：核心贡献在于 progressive disclosure...（略）
evaluation: |
  ## 优点
  - 三级摘要覆盖不同场景
  - 字数约束保证可用性
  - 输出即知识库条目

  ## 局限
  - 深度总结仍可能遗漏立场
  - 图表信息无法提取

  ## 总体评价
  长文消化利器，推荐度 4/5。
guide: |
  ## 步骤
  1. 长文先给一句话摘要判断是否值得读
  2. 值得读再看三级摘要
  3. 引用结论必回查原文

  ## 技巧
  - 多篇摘要后要求横向对比表
  - 标注「作者立场」可识别软文

  ## 常见问题
  - 摘要带私货：要求「只基于原文，不推测」
---

# 长文摘要生成器

把长文压缩成 3 级摘要：一句话、要点清单、深度总结，按需取用。

## 何时使用
- 报告 / 纪要 / 论文的快速消化
- 知识库条目的批量生成

## 输入 / 输出
- 输入：长文全文
- 输出：三级摘要（40 字 / 要点 / 200 字）
