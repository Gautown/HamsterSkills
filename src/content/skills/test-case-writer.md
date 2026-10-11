---
title: 单测用例生成器
titleEn: Unit Test Case Writer
description: 根据函数签名生成覆盖正常、边界、异常路径的单元测试用例清单。
descriptionEn: "Generate unit test cases covering happy path, edge cases and error paths from a function signature."
category: dev
tags: [testing, unit-test, quality]
grade: S
score: 9.2
likes: 33
ratingUp: 10
files:
  - SKILL.md
  - scripts/gen_cases.py
  - templates/jest.spec.ts
prompt: |
  你是测试工程师，请为以下代码生成单元测试用例：
  1. 正常路径（典型输入）
  2. 边界条件（空值、极值、类型错误）
  3. 异常路径（错误处理分支）
  每个用例给出：用例名 / 输入 / 预期输出 / 断言要点。
  目标代码：
  {{code}}
bestFor: 需要快速补齐测试覆盖率、尤其面对遗留模块的开发团队。
steps:
  - 粘贴目标函数或模块到 {{code}}
  - 运行 prompt 得到用例清单
  - 挑选关键用例实现为真实测试
  - 把用例清单归档进 PR 描述
example: |
  happy-path: 输入 [1,2,3] → 返回 6
  edge-empty: 输入 [] → 返回 0
  edge-null: 输入 null → 抛出 TypeError
  error-path: 服务超时 → 重试 3 次后抛错
evaluation: |
  ## 优点
  - 三层路径划分清晰，遗漏率低
  - 用例带断言要点，直接可写
  - 适合作为覆盖率补盲的起点

  ## 局限
  - 不生成具体框架代码，需人工落地
  - 对异步 / 并发代码的用例建议较泛

  ## 总体评价
  补齐单测的高效起点，推荐度 4.5/5。
guide: |
  ## 步骤
  1. 一次只测一个函数，输入更聚焦
  2. 运行后按「风险 × 频率」挑用例先实现
  3. 用例清单随 PR 提交，便于评审

  ## 技巧
  - 注明框架（Jest / Vitest / pytest）可得到更贴近的断言写法
  - 结合覆盖率报告定向补测

  ## 常见问题
  - 生成的用例跑不通：检查桩数据与真实环境差异
---

# 单测用例生成器

根据函数签名生成覆盖正常、边界、异常路径的单元测试用例清单。

## 何时使用
- 新模块写完，快速补齐测试覆盖
- 遗留代码补测前的用例盘点

## 输入 / 输出
- 输入：函数或模块代码
- 输出：分层用例清单（名称 / 输入 / 预期 / 断言）
