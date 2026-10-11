---
title: 费曼式讲解
titleEn: Feynman-style Explanation
description: 用费曼学习法把概念讲给零基础听众：生活类比、分步讲解、自测题。
descriptionEn: "Explain a concept to a beginner with the Feynman technique: analogies, steps, self-test."
category: education
tags: [teaching, explanation, learning]
grade: B
score: 7.6
likes: 15
ratingUp: 5
prompt: |
  用费曼学习法讲解这个概念：
  1. 面向零基础，避免术语
  2. 至少 2 个生活化类比
  3. 分 4-5 步递进讲解
  4. 末尾出 1 道自测题并附答案
  概念：{{topic}}
bestFor: 给零基础听众讲概念的教师、自学者与做技术分享的工程师。
steps:
  - 把概念写入 {{topic}} 位置运行
  - 读讲解，检查类比是否贴合听众背景
  - 做末尾自测题验证理解
  - 答错处让 AI 换角度再讲一遍
example: |
  类比：CPU 像厨房主厨，再快也只能一手做一道菜；
  多核 CPU 等于多位主厨各开一个灶台（并行）。

  自测：为什么线程切换比进程切换开销小？
  答案：共享地址空间，无需切换页表与刷新缓存。
evaluation: |
  ## 优点
  - 生活化类比 + 分步讲解，零基础友好
  - 末尾自测题可验证理解
  - 答错可让模型换角度再讲

  ## 局限
  - 类比深度有限，不适合进阶内容
  - 自测题单一，需多轮追问

  ## 总体评价
  教学与自查两用的讲解器，推荐度 4/5。
guide: |
  ## 步骤
  1. 把概念写入 {{topic}}
  2. 读讲解，检查类比是否贴切
  3. 做自测题，答错让 AI 换角度

  ## 技巧
  - 面向孩子 / 长辈时注明听众背景
  - 连续追问「为什么」逼出更深理解

  ## 常见问题
  - 类比牵强：要求换一类生活场景
---

# 费曼式讲解

用费曼学习法把概念讲给零基础听众：生活类比、分步讲解、自测题。

## 何时使用
- 给新手讲一个技术 / 业务概念
- 自查是否真正理解某个知识点

## 输入 / 输出
- 输入：概念名称
- 输出：类比 + 分步讲解 + 自测题
