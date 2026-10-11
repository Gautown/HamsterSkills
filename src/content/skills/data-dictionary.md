---
title: 数据字典解读
titleEn: Data Dictionary Interpreter
description: 把字段清单翻译成业务可读的数据字典：含义、口径、示例与注意事项。
descriptionEn: Translate a field list into a business-readable data dictionary with meaning, definition, examples and caveats.
category: data
tags: [data-dictionary, documentation, governance]
grade: B
score: 7.5
likes: 11
ratingUp: 4
files:
  - SKILL.md
  - templates/dictionary.md
prompt: |
  请把以下字段清单整理成数据字典，每个字段包含：
  1. 业务含义
  2. 计算口径（何时更新、是否含 null）
  3. 示例值
  4. 使用注意事项
  字段清单：
  {{fields}}
bestFor: 需要向业务方解释表结构、编写数据资产文档的数据团队。
steps:
  - 导出表结构的字段清单（名称 + 类型）
  - 粘贴到 {{fields}} 运行
  - 核对口径描述是否与实际一致
  - 发布到数据资产平台
example: |
  order_amount 订单金额
  含义：订单实付金额（含运费，不含优惠）
  口径：支付成功时写入，退款不冲减
  示例：86.50
  注意：与 GMV 口径不同，勿混用
evaluation: |
  ## 优点
  - 四项结构（含义 / 口径 / 示例 / 注意）完整
  - 强调口径差异，减少误用
  - 输出可直接入库

  ## 局限
  - 口径需要数据工程师确认
  - 不读实际数据，无法验证分布

  ## 总体评价
  数据资产化的实用工具，推荐度 3.5/5。
guide: |
  ## 步骤
  1. 先整理字段名称与类型
  2. 运行后与工程师核对口径
  3. 挂到数据平台供查询

  ## 技巧
  - 重点字段标注「敏感级」
  - 口径变更时同步更新字典

  ## 常见问题
  - 字段含义不清：让 AI 先列出猜测口径再确认
---

# 数据字典解读

把字段清单翻译成业务可读的数据字典：含义、口径、示例与注意事项。

## 何时使用
- 新表上线前编写数据字典
- 业务方频繁问「这个字段是什么意思」

## 输入 / 输出
- 输入：字段清单（名称 + 类型）
- 输出：结构化数据字典
