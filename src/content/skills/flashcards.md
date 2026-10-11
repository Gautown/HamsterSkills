---
title: 知识点闪卡生成
titleEn: Flashcard Generator
description: 把学习材料转成问答闪卡：正面问题、背面答案，含记忆难度标注。
descriptionEn: Turn study material into Q&A flashcards with question, answer and difficulty labels.
category: education
tags: [flashcards, memory, study]
grade: A
score: 8.4
likes: 19
ratingUp: 6
prompt: |
  请把以下学习材料转成闪卡：
  1. 正面：问题（尽量是填空或简答）
  2. 背面：答案（一句话）
  3. 难度：易 / 中 / 难
  4. 关联：与其他卡片的联系
  材料：
  {{material}}
bestFor: 备考或自学时需要把材料转成可复习卡片的学生与终身学习者。
steps:
  - 粘贴教材或笔记到 {{material}}
  - 运行得到闪卡清单
  - 导入 Anki 或打印成卡片
  - 按遗忘曲线安排复习
example: |
  Q: HTTP 与 HTTPS 的核心区别？
  A: HTTPS = HTTP + TLS 加密与身份验证
  难度：易
  关联：与「TLS 握手过程」卡互链
evaluation: |
  ## 优点
  - 问答式输出，直接适配 Anki
  - 难度标注便于分层复习
  - 关联字段帮助建立知识网络

  ## 局限
  - 需人工检查答案准确性
  - 不适合图形类知识

  ## 总体评价
  学习材料卡片化的好帮手，推荐度 4/5。
guide: |
  ## 步骤
  1. 一次粘贴一个主题的材料
  2. 生成后删改到每张卡只考一个点
  3. 导入 Anki 并开启复习计划

  ## 技巧
  - 难卡多拆成几张简单卡
  - 卡片背面只写一句话，拒绝长答案

  ## 常见问题
  - 卡片太密：要求「每张卡只考一个概念」重生成
---

# 知识点闪卡生成

把学习材料转成问答闪卡：正面问题、背面答案，含记忆难度标注。

## 何时使用
- 备考前把教材转成可复习卡片
- 自学时建立长期记忆

## 输入 / 输出
- 输入：学习材料（教材 / 笔记）
- 输出：问答闪卡清单（含难度与关联）
