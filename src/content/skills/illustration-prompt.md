---
title: 插画提示词生成器
titleEn: Illustration Prompt Builder
description: 根据主题生成结构化图像生成提示词，含风格、构图、光线与负面提示词。
descriptionEn: Generate structured image-generation prompts with style, composition, lighting and negative prompts.
category: design
tags: [image-generation, illustration, prompt]
grade: A
score: 8.6
likes: 27
ratingUp: 8
prompt: |
  根据主题生成一段图像生成提示词，包含：
  - 主体描述（最多 2 个主体）
  - 艺术风格（如：吉卜力 / 赛博朋克 / 水彩）
  - 构图与视角
  - 光线与色彩基调
  - 负面提示词（5 条以内）
  主题：{{theme}}
bestFor: 使用 Midjourney / Stable Diffusion 批量出图、追求风格统一的设计师与插画师。
steps:
  - 明确主题、主体数量与期望风格
  - 运行 prompt，得到结构化提示词
  - 按需求微调风格关键词（光线、构图、负面词）
  - 粘贴进生成工具，先出 4 张做 A/B 对比
example: |
  主体：坐在一朵巨型蘑菇上的宇航员，吉卜力风格
  构图：远景，低角度仰拍
  光线：黄昏逆光，暖橙 + 鼠尾草绿
  负面提示词：watermark, lowres, extra fingers, oversaturated
evaluation: |
  ## 优点
  - 输出为结构化提示词，风格 / 构图 / 光线 / 负面词齐全
  - 负面提示词直接给出，减少废片率
  - 可快速在多个生成工具间复用

  ## 局限
  - 依赖主题描述是否清晰，主题模糊则输出发散
  - 风格关键词受目标模型词库影响

  ## 总体评价
  适合批量出图的提示词脚手架，推荐度 4/5。
guide: |
  ## 步骤
  1. 先明确主体数量（建议 ≤ 2 个）
  2. 运行得到提示词后，先出 4 张对比
  3. 根据对比结果微调光线与风格关键词

  ## 技巧
  - 固定一套负面词模板，减少每次重想
  - 把常用风格（吉卜力 / 赛博朋克等）存为词库

  ## 常见问题
  - 出图乱码：减少主体数量并补充构图约束
---

# 插画提示词生成器

根据主题生成结构化图像生成提示词，含风格、构图、光线与负面提示词。

## 何时使用
- 用 Midjourney / Stable Diffusion 批量出图
- 需要风格统一的一套插画（海报、头像、封面）

## 输入 / 输出
- 输入：主题关键词
- 输出：结构化提示词 + 负面提示词
