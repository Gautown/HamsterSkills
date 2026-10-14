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

test('search：默认保留 OOV 词（聊天场景需要它兜底）', () => {
  /*
   * 服务端聊天故意保留「语料里没有的词」：
   * 用户问「Kaggle 竞赛」时，即使没有 Kaggle，
   * 靠「竞赛」这条命中也能给出候选，模型自己判断相关性。
   */
  const index = buildIndex([
    { id: 'comp', title: '竞赛工具', desc: '比赛日程管理', tags: [], category: 'x' },
  ])
  const hits = search(index, 'Kaggle 竞赛')
  assert.ok(hits.length > 0, '宽松模式下 OOV 词不应让结果清零')
})

/**
 * 造一份够大的语料，让倒排不被 cutoff 清空。
 *
 * cutoff 会剔除「出现在半数以上文档里、且词长 ≤2」的词元。
 * 小语料里几乎每个词都过半，倒排会被清空 —— 实测 21 条时
 * 「存在」和「pdf」全被剔除，测试写什么都是空转。
 * 生产语料 8,780 条不会有这个问题，这里造同量级。
 */
function bigCorpus(targets) {
  const filler = Array.from({ length: 200 }, (_, i) => ({
    id: `filler-${i}`,
    title: `Filler Skill ${i}`,
    desc: `auxiliary utility number ${i} for routine chores`,
    tags: [],
    category: 'x',
  }))
  return buildIndex([...targets, ...filler])
}

test('★ search：cjkWholeOnly 挡掉否定短语被劈出的误命中', () => {
  /*
   * 回归：搜「不存在」在真实语料（8,796 条）上命中 4 条技能，
   * 全部由「存在」这一个二元组贡献 —— 二元组切分把否定短语劈成了两半，
   * 「不存在」的「不」被丢掉，剩「存在」成了独立查询词。
   *
   * 探针实测：terms = [不存, 存在]，「不存」df=0，「存在」df=4 → 4 条命中。
   * cjkWholeOnly 下整串「不存在」不在倒排 → 弃用二元组，只留别名展开的
   * 拉丁词元，而「不存在」没有别名 → 0 命中。
   */
  const index = bigCorpus([
    // 这条的描述里写着「存在」，正是被误命中的那类文档
    { id: 'has-existence', title: 'Planning With Files', desc: '判断文件是否存在', tags: [], category: 'x' },
  ])

  const strict = search(index, '不存在', 50, { cjkWholeOnly: true })
  assert.equal(strict.length, 0, `应无结果，实际：${strict.map(h => h.id).join(', ')}`)

  // 确认默认（聊天）模式确实会误命中 —— 否则这条测试是空转
  const loose = search(index, '不存在', 50)
  assert.ok(
    loose.some((h) => h.id === 'has-existence'),
    `默认模式应误命中 has-existence，实际：${loose.map(h => h.id).join(', ') || '(无)'}`,
  )
})

test('search：cjkWholeOnly 不破坏中文别名召回', () => {
  /*
   * cjkWholeOnly 会丢掉全部二元组，唯一还能用的召回路径是别名展开。
   * 若 ZH_ALIASES 失效，「爬虫」这类查询会从有结果变成 0 结果 ——
   * 实测真实语料上「爬虫」靠别名命中 8 条。
   */
  const index = bigCorpus([
    { id: 'crawler', title: 'Web Crawler', desc: 'scrape and crawl websites', tags: [], category: 'x' },
  ])

  const hits = search(index, '爬虫', 50, { cjkWholeOnly: true })
  assert.ok(hits.length > 0, '中文别名召回不应被 cjkWholeOnly 破坏')
  assert.ok(
    hits.some((h) => h.id === 'crawler'),
    `应命中 crawler，实际：${hits.map(h => h.id).join(', ') || '(无)'}`,
  )
})

test('search：cjkWholeOnly 对整串已收录的查询无影响', () => {
  // 整串在倒排里时，二元组本来就该照常参与召回
  const index = bigCorpus([
    { id: 'pdf-main', title: 'PDF 处理', desc: 'split merge extract pdf file', tags: ['pdf'], category: 'x' },
    { id: 'img', title: '图像处理', desc: 'resize crop image', tags: ['image'], category: 'x' },
  ])
  const loose = search(index, 'pdf', 50)
  const strict = search(index, 'pdf', 50, { cjkWholeOnly: true })
  assert.ok(strict.length > 0, 'pdf 是已知词元，应有结果')
  assert.deepEqual(
    strict.map(h => h.id),
    loose.map(h => h.id),
    '纯拉丁查询不受 cjkWholeOnly 影响',
  )
})

test('search：cjkWholeOnly 保留整串已收录的中文查询', () => {
  // 「数据分析」整串就在倒排里 → 二元组照常参与，召回不降
  const index = bigCorpus([
    { id: 'da', title: '数据分析工具', desc: 'analyze data sets', tags: ['数据分析'], category: 'x' },
  ])
  const strict = search(index, '数据分析', 50, { cjkWholeOnly: true })
  assert.ok(
    strict.some(h => h.id === 'da'),
    `整串已收录时应有结果，实际：${strict.map(h => h.id).join(', ') || '(无)'}`,
  )
})

/* ------------------------------ buildIndex ------------------------------ */

/** 取出某篇文档的词项键集合 */
const termsOf = (index, i) => new Set(index.docTerms[i].keys())

test('★ buildIndex：文档侧不做别名展开', () => {
  /*
   * 回归测试。此前 buildIndex 调 tokenize 时不传 opts，
   * 而 tokenize 的默认值是 expand = true（opts.expand !== false），
   * 于是**文档侧也被展开了别名**——与 tokenize 注释里
   * 「expand 只在查询侧开启」的设计意图直接矛盾。
   *
   * 后果：每条含中文的文档都被塞进别名表里的英文词，抬高那些词的 df、
   * 压低 idf，恰好削弱了别名表本想保护的那个信号。
   *
   * 之前的测试只覆盖 tokenize 显式传 opts 的行为（见上方「别名只作用于查询侧」），
   * 天然放过了这个 bug。
   */
  const index = buildIndex([
    { id: 'a', title: '数据抓取助手', desc: '纯中文描述', tags: ['抓取'], category: '开发' },
  ])
  const terms = termsOf(index, 0)
  for (const leaked of ['scrape', 'fetch', 'crawl']) {
    assert.ok(!terms.has(leaked), `文档侧不应出现别名词 ${leaked}，实际词项：${[...terms].join(', ')}`)
  }
  // 中文二元组本身必须在
  assert.ok(terms.has('抓取'), '中文二元组不受影响')
})

test('buildIndex：别名字段只进查询侧，不影响文档排序', () => {
  /*
   * 两条技能：正文真写了 scraping 的应当排在
   * 「分类名里碰巧有中文、但正文与 scraping 无关」的前面。
   * 文档侧展开会人为制造词汇重叠，破坏这个排序。
   */
  const skills = [
    { id: 'unrelated', title: '团队协作平台', desc: 'project management tool', tags: ['team'], category: '抓取' },
    { id: 'real', title: 'Web Scraper', desc: 'a scraping library', tags: ['python'], category: '开发' },
  ]
  const index = buildIndex(skills)
  // 英文查询不应因为中文分类名而命中 unrelated
  const hits = search(index, 'scraping')
  assert.equal(hits.length > 0 && hits[0].id, 'real', `期望 real 排第一，实际：${JSON.stringify(hits.map(h => h.id))}`)
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
