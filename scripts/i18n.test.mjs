/**
 * i18n 词条对称性测试。
 *
 * 为什么需要：
 *   src/i18n/translations.ts 里 T 只是一个 `as const` 对象，
 *   各语言键的结构彼此之间不受 TS 约束。
 *   于是「只删了中文的键」这种错误能通过 astro check（0 errors），
 *   一路走到线上，其它语言直接把 undefined 渲染出来。
 *
 *   这个文件现在有 100+ 键 × 5 语言，全靠人肉比对迟早出事。
 *
 *   本测试覆盖：
 *     - 五种语言键集合完全一致（与 zh 互查，能抓到「只在一边加/删」）
 *     - 没有任何空字符串（漏翻译时最容易留下的痕迹；白名单除外）
 *     - 中英不会出现字面量相同的多余键（复制粘贴残留的信号，仅作提示性断言）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { T } from '../src/i18n/translations.ts'

const LANGS = ['zh', 'zh-tw', 'en', 'ko', 'ms']

test('五种语言的键集合与 zh 完全一致', () => {
  const zh = Object.keys(T.zh).sort()
  for (const lang of LANGS.slice(1)) {
    const keys = Object.keys(T[lang]).sort()
    const onlyZh = zh.filter(k => !keys.includes(k))
    const onlyLang = keys.filter(k => !zh.includes(k))
    assert.deepEqual(
      onlyZh,
      [],
      `只在 zh 里存在、${lang} 缺失（会渲染 undefined）: ${onlyZh.join(', ')}`,
    )
    assert.deepEqual(
      onlyLang,
      [],
      `只在 ${lang} 里存在、zh 缺失（会渲染 undefined）: ${onlyLang.join(', ')}`,
    )
  }
})

test('键数量一致（对称性的粗校验，防止对象被整体替换）', () => {
  const counts = Object.fromEntries(LANGS.map(l => [l, Object.keys(T[l]).length]))
  for (const lang of LANGS) {
    assert.equal(counts[lang], counts.zh, `${lang} 的键数量与 zh 不一致`)
  }
  // 规模意外缩水时立刻发现，不必等某个键真的出事
  assert.ok(counts.zh > 90, `zh 词条数异常偏少: ${counts.zh}`)
})

/**
 * 允许为空的词条 —— 必须写明为什么，否则就是漏翻译。
 * 新增这里的条目时要同时改上面的断言注释，别让白名单悄悄变长。
 */
const ALLOWED_EMPTY = new Map([
  // 评分徽章：zh / zh-tw / ko 拼「等级后缀」（A级 / A級 / A등급），
  // en 与 ms 的显示就是等级字母本身（"Grade A" 由组件分支补上）。
  // 见 SkillDetail.astro 里 gradeLabel 的判断。
  ['en.gradeSuffix', '英文评分不加后缀，渲染走独立的 "Grade X" 分支'],
  ['ms.gradeSuffix', '马来评分不加后缀，渲染走独立的 "Grade X" 分支'],
])

test('没有空字符串词条（白名单除外）', () => {
  for (const lang of LANGS) {
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
    assert.deepEqual(empty, [], `${lang} 存在未登记的空词条: ${empty.join(', ')}`)
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
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(T[lang])) {
      assert.ok(
        typeof v === 'string' || Array.isArray(v),
        `${lang}.${k} 类型非法（实际 ${Array.isArray(v) ? '数组' : typeof v}）`,
      )
    }
  }
})

test('数组词条的五语言长度一致', () => {
  // 数组长度不匹配会让某个语言多出或少掉一列，首屏直接看出来。
  for (const [k, zhVal] of Object.entries(T.zh)) {
    if (!Array.isArray(zhVal)) continue
    const len = zhVal.length
    for (const lang of LANGS.slice(1)) {
      const v = T[lang][k]
      assert.ok(Array.isArray(v), `${lang}.${k} 与 zh 类型不一致`)
      assert.equal(v.length, len, `${lang}.${k} 长度与 zh 不一致`)
    }
  }
})

const EXPECTED_NAMES = {
  zh: '仓鼠AI技能库',
  'zh-tw': '倉鼠AI技能庫',
  en: 'Hamster AI Skills',
  ko: '햄스터 AI 스킬 라이브러리',
  ms: 'Pustaka Kemahiran AI Hamster',
}

test('品牌名五语言各自独立', () => {
  // 这是品牌硬约束：各语言站各自的名字，改名要同步改这里和实际站点。
  // 曾经有一版把中文站写成英文名，或两边写成同一个。
  const seen = new Set()
  for (const lang of LANGS) {
    assert.equal(T[lang].siteName, EXPECTED_NAMES[lang], `${lang}.siteName 与约定不符`)
    assert.ok(!seen.has(T[lang].siteName), `siteName 出现重复：${T[lang].siteName}`)
    seen.add(T[lang].siteName)
  }
})

test('中英不应存在字面量完全相同的词条', () => {
  // 少数词（品牌名、技术名词）本就可以相同，出现大面积相同通常是漏翻译。
  // 阈值放宽到 20%，只为暴露"整段忘记翻译"这类批量问题。
  // 数组词条按元素逐一比对。
  const pairs = [
    ['zh', 'en'],
    ['zh', 'zh-tw'],
    ['zh', 'ko'],
    ['zh', 'ms'],
  ]
  for (const [a, b] of pairs) {
    const same = []
    for (const [k, aVal] of Object.entries(T[a])) {
      const bVal = T[b][k]
      if (Array.isArray(aVal) && Array.isArray(bVal)) {
        if (JSON.stringify(aVal) === JSON.stringify(bVal)) same.push(k)
      } else if (aVal === bVal) {
        same.push(k)
      }
    }
    const ratio = same.length / Object.keys(T[a]).length
    assert.ok(
      ratio < 0.3,
      `${a} 与 ${b} 字面量相同的词条过多（${same.length}/${Object.keys(T[a]).length} = ${(ratio * 100).toFixed(0)}%），疑似批量漏翻译: ${same.slice(0, 8).join(', ')}`,
    )
  }
})
