---
title: 代码审查助手
titleEn: Code Review Buddy
description: 按固定维度系统化审查代码，输出带严重级别的问题清单与修改示例。
descriptionEn: Systematically review code against fixed dimensions and output an issue list with severity levels and fix examples.
category: dev
tags: [code-review, quality, best-practices]
grade: S
score: 9.1
likes: 42
ratingUp: 12
files:
  - SKILL.md
  - scripts/init_skill.py
  - scripts/validate.py
  - LICENSE.txt
prompt: |
  你是一位资深工程师，请按以下维度审查这段代码：
  1. 正确性：边界条件、空值、并发问题
  2. 安全性：注入、越权、敏感信息泄漏
  3. 性能：热点路径、内存占用
  4. 可维护性：命名、重复代码、圈复杂度
  每条问题标注严重级别（P0-P2）并给出修改示例。
  待审查代码：
  {{code}}
bestFor: 需要统一代码审查标准、快速定位高风险改动问题的工程团队。
steps:
  - 把待审查代码粘贴到 prompt 的 {{code}} 位置
  - 运行 prompt，得到带 P0-P2 级别的问题清单
  - 逐条对照代码确认问题，按示例修改
  - P0 问题附上修复 diff 提交团队复核
example: |
  P0 安全
  - 第 12 行 SQL 直接拼接用户输入，存在注入风险
    修复：db.query('SELECT * FROM users WHERE id = ?', [id])

  P1 性能
  - 循环内逐条查询（N+1），改为批量 fetch，预计 RT 下降 80%

  P2 可维护性
  - retry() 与 execute() 存在重复逻辑，建议抽取公共函数
evaluation: |
  ## 优点
  - 固定审查维度（正确性 / 安全 / 性能 / 可维护性），遗漏率低
  - 每条问题附修改示例，可直接落地
  - P0-P2 分级便于团队排优先级

  ## 局限
  - 依赖粘贴的代码上下文，跨文件推理能力有限
  - 示例为通用建议，需按团队规范适配

  ## 总体评价
  适合作为日常代码审查的清单工具，推荐度 4/5。
guide: |
  ## 步骤
  1. 大 PR 建议按模块拆分后逐段审查
  2. 粘贴代码时注明语言与框架
  3. P0 问题优先修复，P1/P2 进待办清单

  ## 技巧
  - 附上改动意图说明，可让审查更聚焦
  - 可作为合并前的质量门禁反复使用

  ## 常见问题
  - 能发现逻辑 bug 吗：主要覆盖边界 / 并发 / 空值类问题，业务逻辑错误仍需人工描述
---

# 代码审查助手

按固定维度系统化审查代码，输出带严重级别的问题清单与修改示例。

## 何时使用
- PR 合并前的质量检查
- 遗留代码的风险巡检
- 新人上手时理解团队代码规范

## 输入 / 输出
- 输入：代码片段或完整文件
- 输出：P0-P2 分级问题清单 + 修复示例
