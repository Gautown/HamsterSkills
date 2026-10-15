/**
 * i18n 词条对称性测试。
 *
 * 为什么需要：
 *   src/i18n/translations.ts 里 T 只是一个 `as const` 对象，
 *   `en` 的键结构**没有**受 `zh` 约束 —— TS 不会要求两边键完全一致。
 *   于是「只删了中文的键」这种错误能通过 astro check（0 errors），
 *   一路走到线上，另一种语言直接把 undefined 渲染出来。
 *
 *   这个文件里有 100+ 键，全靠人肉比对迟早出事。
 *
 *   本测试覆盖：
 *     - 中英键集合完全一致（双向检查，能抓到「只在一边加」和「只在一边删」）
 *     - 没有任何空字符串（漏翻译时最容易留下的痕迹）
 *     - 中英不会出现字面量相同的多余键（复制粘贴残留的信号，仅作提示性断言）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { T } from '../src/i18n/translations.ts'

test('zh 与 en 的键集合完全一致', () => {
  const zh = Object.keys(T.zh).sort()
  const en = Object.keys(T.en).sort()

  const onlyZh = zh.filter(k => !en.includes(k))
  const onlyEn = en.filter(k => !zh.includes(k))

  assert.deepEqual(onlyZh, [], `只在 zh 里存在、en 缺失（会渲染 undefined）: ${onlyZh.join(', ')}`)
  assert.deepEqual(onlyEn, [], `只在 en 里存在、zh 缺失（会渲染 undefined）: ${onlyEn.join(', ')}`)
})

test('键数量一致（对称性的粗校验，防止对象被整体替换）', () => {
  assert.equal(Object.keys(T.zh).length, Object.keys(T.en).length)
  // 规模意外缩水时立刻发现，不必等某个键真的出事
  assert.ok(Object.keys(T.zh).length > 90, `zh 词条数异常偏少: ${Object.keys(T.zh).length}`)
})

/**
 * 允许为空的词条 —— 必须写明为什么，否则就是漏翻译。
 * 新增这里的条目时要同时改上面的断言注释，别让白名单悄悄变长。
 */
const ALLOWED_EMPTY = new Map([
  // 英文站的评分显示就是等级字母本身（A/B/C），中文才加「级」后缀。
  // 见 SkillDetail.astro 里 gradeLabel 的三元判断。
  ['en.gradeSuffix', '英文评分不带后缀，与中文的「A级」对应'],
])

test('没有空字符串词条（白名单除外）', () => {
  for (const lang of ['zh', 'en']) {
    const empty = []
    for (const [k, v] of Object.entries(T[lang])) {
      if (typeof v === 'string') {
        if (v.trim() === '' && !ALLOWED_EMPTY.has(`${lang}.${k}`)) empty.push(`${lang}.${k}`)
      } else if (Array.isArray(v)) {
        // tryLinks 这类词条是数组，逐项检查：空数组、空项、含非字符串都要暴露
        if (v.length === 0) empty.push(`${lang}.${k}(空数组)`)
        v.forEach((item, i) => {
          if (typeof item !== 'string' || item.trim() === '') empty.push(`${lang}.${k}[${i}]`)
        })
      }
    }
    assert.deepEqual(empty, [], `存在未登记的空词条: ${empty.join(', ')}`)
  }
})

test('白名单里的每个条目都确实是空的（防止注释与实际脱节）', () => {
  // 白名单写着「这里本来就该是空的」，但万一后来有人给它填了内容，
  // 那条说明就成了误导，必须同步删掉白名单项。
  for (const [key, reason] of ALLOWED_EMPTY) {
    const [lang, k] = key.split('.')
    const v = T[lang]?.[k]
    const isEmpty = typeof v === 'string' ? v.trim() === '' : Array.isArray(v) && v.length === 0
    assert.ok(isEmpty, `${key} 已有内容（${JSON.stringify(v)}），应从白名单移除。原因原为：${reason}`)
  }
})

test('空词条白名单本身没有过期项', () => {
  // 词条被删掉后，白名单里残留的条目会掩盖「这里本该有内容」。
  for (const key of ALLOWED_EMPTY.keys()) {
    const [lang, k] = key.split('.')
    assert.ok(T[lang]?.[k] !== undefined, `白名单条目 ${key} 已失效（词条不存在或语言名写错）`)
  }
})

test('词条只允许 string 或 string[]', () => {
  // T 只是 `as const`，没有联合类型约束；
  // 误塞对象/数字进来 TS 不会报错，运行时会直接渲染出 [object Object]。
  for (const lang of ['zh', 'en']) {
    for (const [k, v] of Object.entries(T[lang])) {
      assert.ok(
        typeof v === 'string' || Array.isArray(v),
        `${lang}.${k} 类型非法（实际 ${Array.isArray(v) ? '数组' : typeof v}）`,
      )
    }
  }
})

test('数组词条的中英长度一致', () => {
  // 数组长度不匹配会让某个语言多出或少掉一列，首屏直接看出来。
  for (const [k, zhVal] of Object.entries(T.zh)) {
    if (!Array.isArray(zhVal)) continue
    const enVal = T.en[k]
    assert.ok(Array.isArray(enVal), `en.${k} 与 zh 类型不一致`)
    assert.equal(enVal.length, zhVal.length, `en.${k} 长度与 zh 不一致`)
  }
})

test('品牌名中英均已改名且不互换', () => {
  // 这两个是品牌硬约束：中文站与英文站各自的名字。
  // 曾经有一版把中文站写成英文名，或两边写成同一个。
  assert.equal(T.zh.siteName, '仓鼠AI技能库')
  assert.equal(T.en.siteName, 'Hamster AI Skills')
  assert.notEqual(T.zh.siteName, T.en.siteName)
})

test('中英不应存在字面量完全相同的词条', () => {
  // 少数词（品牌名、技术名词）本就可以相同，出现大面积相同通常是漏翻译。
  // 阈值放宽到 20%，只为暴露"整段忘记翻译"这类批量问题。
  // 数组词条按元素逐一比对。
  const same = []
  for (const [k, zhVal] of Object.entries(T.zh)) {
    const enVal = T.en[k]
    if (Array.isArray(zhVal) && Array.isArray(enVal)) {
      if (JSON.stringify(zhVal) === JSON.stringify(enVal)) same.push(k)
    } else if (zhVal === enVal) {
      same.push(k)
    }
  }
  const ratio = same.length / Object.keys(T.zh).length
  assert.ok(
    ratio < 0.2,
    `中英字面量相同的词条过多（${same.length}/${Object.keys(T.zh).length} = ${(ratio * 100).toFixed(0)}%），疑似批量漏翻译: ${same.slice(0, 8).join(', ')}`,
  )
})