---
title: CSV 数据快速分析
titleEn: Quick CSV Analysis
description: 对表格数据完成概况、关键指标统计与异常检测，并给出一句话结论。
descriptionEn: "Profile a dataset: overview, key metrics, anomaly detection, and a one-line conclusion."
category: data
tags: [csv, analysis, visualization]
grade: A
score: 8.5
likes: 25
ratingUp: 9
files:
  - SKILL.md
  - scripts/profile.py
  - scripts/detect_outliers.py
  - templates/report.md
prompt: |
  你是数据分析师，请对以下数据完成：
  1. 数据概况（行数、字段、缺失值）
  2. 关键指标统计
  3. 异常值及其可能原因
  4. 一句话结论
  用 Markdown 表格输出结果。
  数据：
  {{csv}}
bestFor: 需要快速摸清一份新数据、发现异常但不写代码的运营与财务同学。
steps:
  - 预处理 CSV（补缺失值、统一日期格式）
  - 将数据粘贴到 {{csv}} 位置运行
  - 重点阅读「关键指标」与「异常值」两节
  - 将一句话结论用于周报摘要
example: |
  数据概况
  行数 12,847 · 缺失率 3.2%（city 字段）

  关键指标
  月均订单 8,431 · 客单价 86.5 · 复购率 21%

  异常
  3/15 订单量突增 6 倍，疑似数据重复录入

  结论：3 月订单环比增长 18%，主要由新增城市贡献。
evaluation: |
  ## 优点
  - 四项分析（概况 / 指标 / 异常 / 结论）一次跑完
  - 输出为 Markdown 表格，可直接贴进周报
  - 异常值带可能原因，便于定位

  ## 局限
  - 超大数据集需先抽样
  - 结论为启发式，关键决策需复核

  ## 总体评价
  数据摸底的好起点，推荐度 4/5。
guide: |
  ## 步骤
  1. 先做缺失值与日期格式预处理
  2. 大数据集先抽样 1 万行
  3. 重点读异常值一节

  ## 技巧
  - 在输入中注明单位与口径（如「金额单位：元」）
  - 结论一句话可直接作为周报摘要

  ## 常见问题
  - 指标算错：检查口径是否一致（同比 vs 环比）
---

# CSV 数据快速分析

对表格数据完成概况、关键指标统计与异常检测，并给出一句话结论。

## 何时使用
- 接手一份新数据先摸底
- 周报前快速出指标与异常

## 输入 / 输出
- 输入：CSV 数据（可抽样）
- 输出：Markdown 分析结果 + 一句话结论
