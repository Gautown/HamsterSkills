/**
 * 站内技能检索测试（node:test，零依赖、不联网）
 *
 * 运行：node --test scripts/search-index.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIndex, formatHits, search, toSearchable, tokenize } from '../src/lib/search-index.mjs'

const sample = [
  {
    id: 'pdf-processing',
    title: 'PDF Processing',
    desc: 'Inspect, extract, OCR, create, merge, split, reorder, rotate PDF files.',
    category: 'office',
    tags: ['PDF', 'Document'],
  },
  {
    id: 'web-scraping',
    title: 'Web Scraping',
    desc: 'Scrape websites and crawl pages with a headless browser crawler.',
    category: 'dev',
    tags: ['Crawler'],
  },
  {
    id: 'code-review',
    title: '代码审查助手',
    desc: '对提交的代码做 review，指出潜在缺陷与可改进点。',
    category: 'dev',
    tags: [],
  },
  {
    id: 'translate',
    title: 'Translate',
    desc: 'Translate text between languages, supporting i18n workflows.',
    category: 'writing',
    tags: [],
  },
  {
    id: 'unrelated-thing',
    title: 'Weather Widget',
    desc: 'Display a weather widget on a dashboard.',
    category: 'dev',
    tags: [],
  },
]

const index = buildIndex(toSearchable(sample))

/* ------------------------------ tokenize ------------------------------ */

test('tokenize：英文按词切分并小写', () => {
  const t = tokenize('PDF Processing')
  assert.ok(t.includes('pdf'))
  assert.ok(t.includes('processing'))
})

test('tokenize：中文切二元组，并展开别名', () => {
  // 「代码审查」既切出三个二元组，也命中别名表展开出英文词
  assert.deepEqual(tokenize('代码审查'), ['代码', '码审', '审查', 'review', 'reviewer'])
  assert.deepEqual(tokenize('代码审查', { expand: false }), ['代码', '码审', '审查'])
})

test('tokenize：单字中文保留整段', () => {
  assert.deepEqual(tokenize('猫'), ['猫'])
})

test('tokenize：去掉停用词', () => {
  const t = tokenize('how to write a skill')
  assert.ok(!t.includes('how'))
  assert.ok(!t.includes('the'))
  assert.ok(t.includes('write'))
  // skill 本身在停用词表里：站内每条都是技能，该词无区分度
  assert.ok(!t.includes('skill'))
})

test('tokenize：英文单字母被丢弃（噪声大）', () => {
  assert.ok(!tokenize('a b c').includes('a'))
})

test('tokenize：别名只作用于查询侧', () => {
  // 展开：爬虫 → crawler / scraping
  const expanded = tokenize('爬虫', { expand: true })
  assert.ok(expanded.includes('crawler'), '查询侧应展开别名')
  assert.ok(expanded.includes('scraping'))
  // 文档侧不展开，否则每篇文档都会被塞进无关英文词，扭曲词频
  const plain = tokenize('爬虫', { expand: false })
  assert.ok(!plain.includes('crawler'), '文档侧不应展开别名')
})

test('tokenize：空输入返回空数组', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize(null), [])
  assert.deepEqual(tokenize(undefined), [])
})

/* ---------------------------- toSearchable ---------------------------- */

test('toSearchable：只保留检索所需字段', () => {
  const out = toSearchable(sample)
  assert.equal(out.length, 5)
  assert.deepEqual(Object.keys(out[0]).sort(), ['category', 'desc', 'id', 'tags', 'title'])
})

test('toSearchable：丢弃缺 id 的条目', () => {
  assert.equal(toSearchable([{ title: 'x' }, null, { id: 'ok', title: 'ok' }]).length, 1)
})

test('toSearchable：描述按上限截断', () => {
  const out = toSearchable([{ id: 'a', title: 'a', desc: 'x'.repeat(300) }], 50)
  assert.equal(out[0].desc.length, 50)
})

test('toSearchable：tags 非数组时降级为空', () => {
  const out = toSearchable([{ id: 'a', title: 'a', tags: 'not-an-array' }])
  assert.deepEqual(out[0].tags, [])
})

/* ----------------------------- buildIndex ----------------------------- */

test('buildIndex：空输入产出可用但空的索引', () => {
  const idx = buildIndex([])
  assert.equal(idx.size, 0)
  assert.deepEqual(search(idx, 'anything'), [])
})

test('buildIndex：title 权重高于 desc', () => {
  // 标题含 PDF 的应排在正文含 PDF 的前面
  const hits = search(index, 'pdf')
  assert.equal(hits[0].id, 'pdf-processing', '标题命中应排在前面')
})

test('buildIndex：tags 参与检索', () => {
  const hits = search(index, 'headless')
  assert.ok(hits.some(h => h.id === 'web-scraping'))
})

/* ------------------------------- search ------------------------------- */

test('search：英文精确命中', () => {
  const hits = search(index, 'pdf')
  assert.ok(hits.length > 0)
  assert.equal(hits[0].id, 'pdf-processing')
})

test('search：★ 中文查询经别名命中英文技能', () => {
  // 语料里没有「爬虫」二字，只有 scraping / crawler
  const hits = search(index, '爬虫')
  assert.ok(hits.length > 0, '中文别名应让「爬虫」命中 web-scraping')
  assert.equal(hits[0].id, 'web-scraping')
})

test('search：中文查询命中中文技能', () => {
  const hits = search(index, '代码审查')
  assert.ok(hits.length > 0)
  assert.ok(hits.some(h => h.id === 'code-review'))
})

test('search：零词汇重叠时返回空', () => {
  assert.deepEqual(search(index, '火锅麻辣烫'), [])
  assert.deepEqual(search(index, 'zzzz qqqq'), [])
})

test('search：只受停用词影响时返回空', () => {
  assert.deepEqual(search(index, 'the and of'), [])
})

test('search：结果按分数降序', () => {
  const hits = search(index, 'review code', 5)
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1].score >= hits[i].score, '必须严格降序')
  }
})

test('search：相同查询结果稳定（可复现）', () => {
  const a = search(index, 'pdf document', 5).map(h => h.id).join(',')
  const b = search(index, 'pdf document', 5).map(h => h.id).join(',')
  assert.equal(a, b)
})

test('search：k 限制返回条数', () => {
  assert.ok(search(index, 'code', 2).length <= 2)
})

test('search：绝对下限能滤掉弱命中', () => {
  assert.deepEqual(search(index, 'weather dashboard', 10, { minScore: 9999 }), [])
})

test('search：相对下限裁掉长尾', () => {
  const all = search(index, 'pdf document merge split', 50, { relFloor: 0, minScore: 0 })
  const trimmed = search(index, 'pdf document merge split', 50, { relFloor: 0.9, minScore: 0 })
  assert.ok(all.length > 0)
  assert.ok(trimmed.length <= all.length, '相对阈值只会让结果变少')
})

/* ---------------------------- formatHits ---------------------------- */

test('formatHits：空数组返回空串', () => {
  assert.equal(formatHits([]), '')
})

test('formatHits：含标题、路径与分类', () => {
  const text = formatHits(search(index, 'pdf', 3))
  assert.match(text, /PDF Processing/)
  assert.match(text, /\/skills\/pdf-processing\//)
  assert.match(text, /office/)
})

test('formatHits：描述按 maxDesc 截断', () => {
  const text = formatHits(search(index, 'pdf', 1), { maxDesc: 20 })
  assert.ok(text.length < 300)
})

test('formatHits：编号从 1 开始', () => {
  const text = formatHits(search(index, 'pdf', 3))
  assert.match(text, /^按你的问题从站内检索到的相关技能[\s\S]*\n1\. /)
})

test('formatHits：每条都写全路径，避免模型照抄成坏链接', () => {
  const text = formatHits(search(index, 'pdf', 3))
  assert.match(text, /\/skills\/pdf-processing\//)
  for (const line of text.split('\n').slice(1)) {
    const m = line.match(/路径 (\S+)/)
    assert.ok(m, `每条都应含「路径」字段：${line}`)
    assert.match(m[1], /^\/skills\/[a-z0-9-]+\/$/, `路径须以 /skills/ 开头、/ 结尾：${m[1]}`)
  }
})
