---
title: 配色方案生成
titleEn: Color Palette Generator
description: 根据品牌气质与使用场景生成 5 色配色方案，附 HEX、对比度与使用比例建议。
descriptionEn: Generate a 5-color palette from brand mood and usage context, with HEX values, contrast notes and ratio advice.
category: design
tags: [color, palette, ui-design]
grade: B
score: 7.6
likes: 12
ratingUp: 4
added: '2026-09-09'
prompt: |
  请生成 5 色配色方案（主色 / 辅色 / 强调色 / 中性深 / 中性浅）：
  1. 每色附 HEX 与用途
  2. 主色在中性深 / 浅上的对比度是否达标（AA）
  3. 使用比例建议（如 60/30/10）
  品牌气质：{{mood}}，使用场景：{{scene}}
bestFor: UI 项目启动前定视觉基调的产品与设计师。
steps:
  - 写清品牌气质（如「克制、科技」）与主要场景（网页 / App / 印刷）
  - 运行得到 5 色方案
  - 实际 UI 里套 60/30/10 验证
  - 不达标时调整再验证
example: |
  主 #0078D4（标题 / 按钮，60%）
  辅 #005A9E（hover / 次级按钮，30%）
  强调 #FFB900（高亮 / 告警，10%）
  深 #1B1B1B（正文） 浅 #F3F2F1（背景）
  对比度：白字 + 主色 4.6:1，AA 达标
evaluation: |
  ## 优点
  - 比例建议直接可用于设计稿
  - 附对比度校验，少踩可访问性坑
  - 气质描述可量化输出

  ## 局限
  - 审美判断有限，重要品牌需人工把关
  - 不生成渐变 / 材质建议

  ## 总体评价
  定基调阶段的效率工具，推荐度 3.5/5。
guide: |
  ## 步骤
  1. 一次要 3 套方案对比
  2. 用 60/30/10 套进真实页面
  3. 定稿后输出色值文档

  ## 技巧
  - 场景写「暗色模式优先」会多给一组深色方案
  - 强调色限定 10% 以内

  ## 常见问题
  - 方案太保守：气质加反差词（如「大胆」）
---

# 配色方案生成

根据品牌气质与使用场景生成 5 色配色方案，附 HEX、对比度与使用比例建议。

## 何时使用
- 新项目视觉基调确定
- 现有设计系统扩展新色板

## 输入 / 输出
- 输入：品牌气质 + 使用场景
- 输出：5 色方案（HEX / 对比度 / 比例）
