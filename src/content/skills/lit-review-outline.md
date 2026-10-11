---
title: 文献综述提纲
titleEn: Literature Review Outline
description: 根据研究主题生成文献综述提纲：脉络、学派、争议点与参考文献结构。
descriptionEn: Generate a literature review outline from a research topic with threads, schools, debates and reference structure.
category: research
tags: [literature, writing, academic]
grade: A
score: 8.5
likes: 21
ratingUp: 7
prompt: |
  为研究主题生成文献综述提纲：
  1. 研究脉络（按时间或学派）
  2. 主要学派与代表工作
  3. 争议点与研究空白
  4. 建议的章节结构（3-5 节）
  主题：{{topic}}，范围：近 {{years}} 年
bestFor: 开题或写综述前需要快速搭框架的研究生与科研人员。
steps:
  - 写清主题与年限范围
  - 运行得到提纲
  - 按提纲逐节检索文献
  - 边读边往提纲里填引用
example: |
  1. 脉络：2018 规则方法 → 2021 预训练 → 2024 智能体
  2. 学派：符号主义 vs 连接主义，代表工作各 3 篇
  3. 空白：长上下文下的可解释性
  4. 章节：背景 / 方法对比 / 开放问题 / 小结
evaluation: |
  ## 优点
  - 脉络 + 学派 + 空白三段式符合综述规范
  - 章节结构可直接用于写作
  - 范围可控（年限参数）

  ## 局限
  - 具体文献需自行检索核实
  - 不替代对领域的一手阅读

  ## 总体评价
  综述写作的骨架工具，推荐度 4/5。
guide: |
  ## 步骤
  1. 先用综述提纲确定章节
  2. 每节检索 5-10 篇代表文献
  3. 用「论文快读」逐篇提取要点填入

  ## 技巧
  - 与「论文快读」组合使用效果最佳
  - 争议点部分单独成节更显深度

  ## 常见问题
  - 提纲太泛：主题加限定词（方法 + 场景）
---

# 文献综述提纲

根据研究主题生成文献综述提纲：脉络、学派、争议点与参考文献结构。

## 何时使用
- 开题报告 / 综述章节写作前搭框架
- 进入新领域时快速建立学术地图

## 输入 / 输出
- 输入：研究主题（+ 年限范围）
- 输出：综述提纲（脉络 / 学派 / 空白 / 章节）
