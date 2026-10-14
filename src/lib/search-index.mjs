/**
 * 站内技能检索：给聊天助手提供事实依据。
 *
 * 为什么必须检索而不是整库塞进提示：
 *   全站 8,800+ 技能，id + 描述合计就约 0.15 MB（≈43k tokens），
 *   加上其它字段更夸张。每个请求都带上一份既贵又不准——
 *   token 超限会被截断，而截断后的答案不如没有。
 *   改为「按问题检索 top-K 注入」，单次多约 1-2k tokens。
 *
 * 为什么不用 BM25 / 向量库：
 *   Worker 里没有第三方依赖，向量检索还要额外建库与调用嵌入接口。
 *   这里用「IDF 加权的词项重叠」，对 8,800 条规模足够——
 *   线性扫描一次约几毫秒，换 isolate 冷启动的一次性加载完全划算。
 *
 * 中文没有空格，按二元组（bigram）切分；英文/数字按词切分。
 * 这个模块是纯函数，无网络依赖，可离线单测。
 */

/**
 * 单条技能的检索形态（由 skills-index.json 精简而来）。
 *
 * @typedef {Object} SearchableSkill
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {string} category
 * @property {string[]} tags
 */

/**
 * 一条检索命中。
 *
 * @typedef {Object} SearchHit
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {string} category
 * @property {number} score
 */

/** @typedef {ReturnType<typeof buildIndex>} SearchIndex */

/* ------------------------------ 分词 ------------------------------ */

/** CJK 与其它文字的判定：CJK 没有空格，必须按二元组处理 */
const CJK = /[㐀-䶿一-鿿豈-﫿]/

/** 英文/数字词，长度 ≥2 才保留；单个字母噪声太大 */
const LATIN_WORD = /[a-z0-9][a-z0-9+#.-]*/g

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'can', 'this',
  'that', 'from', 'have', 'has', 'not', 'but', 'all', 'any', 'how', 'what',
  'use', 'using', 'used', 'does', 'do', 'skill', 'skills', 'please', 'help',
  'me', 'i', 'to', 'of', 'in', 'on', 'it', 'is', 'be', 'or', 'a', 'an',
  '的', '了', '和', '是', '在', '我', '有', '个', '吗', '呢', '吧', '啊',
  '请', '帮', '怎么', '如何', '什么', '可以', '一个', '这个', '那个',
])

/**
 * 中文 → 英文别名表：补跨语言检索的缺口。
 *
 * 为什么需要：站内 95% 的技能描述是英文（实测 8,803 条里仅 5% 含中文）。
 * 用户用中文提问时，词法匹配几乎打不中英文描述——
 * 例如「爬虫」在语料里出现 0 次，而 scrap 出现 66 次。
 * 这里把常见中文技术词展开成对应的英文词项，与原文一起参与检索。
 *
 * 这不是完整的同义词系统，只覆盖高频词；扩充时挑「站内确有对应技能」的词，
 * 否则只会引入噪声。检索本身仍是兜底：展开得不准时，模型拿到的也只是
 * 候选清单，而系统提示已要求它「清单外就说不知道，不要编造」。
 */
const ZH_ALIASES = {
  爬虫: ['crawler', 'crawling', 'scraping'],
  爬取: ['scrape', 'scraping', 'crawl'],
  抓取: ['scrape', 'fetch', 'crawl'],
  翻译: ['translate', 'translation', 'i18n'],
  国际化: ['i18n', 'internationalization', 'localization'],
  文档: ['document', 'docs', 'documentation'],
  写作: ['writing', 'writer', 'blog', 'article'],
  图表: ['chart', 'plot', 'graph', 'visualization'],
  绘图: ['draw', 'plot', 'visualization', 'diagram'],
  图片: ['image', 'picture', 'photo'],
  图像: ['image', 'vision', 'picture'],
  视频: ['video'],
  音频: ['audio', 'sound', 'music', 'speech'],
  代码审查: ['review', 'reviewer'],
  代码评审: ['review', 'reviewer'],
  重构: ['refactor', 'refactoring'],
  调试: ['debug', 'debugging'],
  测试: ['test', 'testing', 'testcase'],
  部署: ['deploy', 'deployment', 'devops'],
  数据库: ['database', 'sql', 'postgres', 'mysql'],
  接口: ['api', 'endpoint', 'rest', 'graphql'],
  前端: ['frontend', 'react', 'vue'],
  后端: ['backend', 'server'],
  数据分析: ['analysis', 'analytics', 'analyze'],
  机器学习: ['machine learning', 'training'],
  深度学习: ['deep learning', 'neural', 'transformer'],
  表格: ['spreadsheet', 'excel', 'csv', 'table'],
  幻灯片: ['slide', 'presentation', 'ppt', 'deck'],
  邮件: ['email', 'mail', 'smtp'],
  安全: ['security', 'vulnerability', 'audit'],
  性能: ['performance', 'optimize', 'optimization', 'profiling'],
  监控: ['monitor', 'monitoring', 'observability', 'metrics'],
  日志: ['log', 'logging', 'logger'],
  搜索: ['search', 'searching', 'retrieval'],
  架构: ['architecture', 'architect'],
  知识库: ['knowledge base', 'rag'],
  记忆: ['memory', 'remember', 'note'],
  总结: ['summarize', 'summary', 'tldr'],
  提示词: ['prompt', 'prompting'],
  智能体: ['agent', 'agentic', 'autonomous'],
}

/**
 * 切分为检索词项。
 *
 * - 英文/数字：按词（小写），长度 ≥2
 * - CJK 连续段：切二元组，单字落只保留整段
 * - `expand` 为真时额外展开中文别名（**只在查询侧开启**）
 * - 去停用词
 *
 * @param {string} text
 * @param {{expand?: boolean}} [opts] expand 仅用于查询侧；
 *   文档侧若也展开，等于给每条文档塞进一堆无关英文词，会扭曲词频
 */
export function tokenize(text, opts = {}) {
  if (!text) return []
  const expand = opts.expand !== false
  const out = []
  const lower = String(text).toLowerCase()

  // 英文 / 数字词
  for (const m of lower.matchAll(LATIN_WORD)) {
    const w = m[0].replace(/[.-]+$/, '')
    if (w.length < 2 || STOPWORDS.has(w)) continue
    out.push(w)
  }

  // CJK 二元组
  for (const m of lower.matchAll(/[㐀-䶿一-鿿豈-﫿]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      out.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2)
      if (STOPWORDS.has(bg)) continue
      out.push(bg)
    }
  }

  // 中文别名展开：让「爬虫」能命中描述里写着 scraping 的技能
  if (expand) {
    for (const [zh, en] of Object.entries(ZH_ALIASES)) {
      if (!lower.includes(zh)) continue
      for (const part of tokenizePlain(en.join(' '))) out.push(part)
    }
  }

  return out
}

/** 不做别名展开、不做 CJK 切分的纯英文分词（供别名表自身使用，避免递归） */
function tokenizePlain(text) {
  const out = []
  for (const m of String(text ?? '').toLowerCase().matchAll(LATIN_WORD)) {
    const w = m[0].replace(/[.-]+$/, '')
    if (w.length >= 2 && !STOPWORDS.has(w)) out.push(w)
  }
  return out
}

/* ------------------------------ 索引 ------------------------------ */

/**
 * 把 skills-index.json 的条目转成精简的检索形态。
 * 只保留检索与展示需要的字段，顺带截断描述以控制注入体积。
 *
 * @param {Array<Record<string, any>>} items
 * @param {number} [descLimit]
 * @returns {SearchableSkill[]}
 */
export function toSearchable(items, descLimit = 160) {
  const out = []
  for (const raw of items ?? []) {
    if (!raw || typeof raw.id !== 'string') continue
    const desc = String(raw.desc ?? raw.descEn ?? raw.description ?? '')
    out.push({
      id: raw.id,
      title: String(raw.title ?? raw.titleEn ?? raw.id),
      desc: desc.length > descLimit ? desc.slice(0, descLimit) : desc,
      category: String(raw.category ?? ''),
      tags: Array.isArray(raw.tags) ? raw.tags.filter(t => typeof t === 'string').slice(0, 6) : [],
    })
  }
  return out
}

/**
 * 为技能集构建检索结构：词项 → IDF 权重，以及每篇文档的词频。
 * 一次性构建，之后每次查询只做 O(查询词数) 的累加。
 *
 * @param {SearchableSkill[]} skills
 * @returns {SearchIndex}
 */
export function buildIndex(skills) {
  const docTerms = []
  const docFreq = new Map()
  const postings = new Map()

  for (let i = 0; i < skills.length; i++) {
    const s = skills[i]
    /*
     * 标题与描述权重更高：同一个词在标题里出现更可能是用户想要的。
     *
     * 四处都必须显式传 `expand: false`。tokenize 的默认值是
     * `opts.expand !== false`（undefined 也算开），漏传就会让**文档侧**
     * 也展开别名——与 tokenize 自己注释里「只在查询侧开启」的设计意图矛盾。
     *
     * 实际后果（实测）：一条 title 为「数据抓取助手」的技能，
     * 文档侧词项里会混进 scrape / fetch / crawl 三个源文本根本没有的词，
     * 抬高它们的 df、压低 idf，恰好削弱别名表本想保护的那个信号，
     * 还让人为制造的词汇重叠污染排序。
     *
     * 别名只在 search() 查询侧展开，见该函数。
     */
    const titleTokens = tokenize(s.title, { expand: false })
    const descTokens = tokenize(s.desc, { expand: false })
    const tagTokens = s.tags.flatMap(t => tokenize(t, { expand: false }))
    const catTokens = tokenize(s.category, { expand: false })

    const counts = new Map()
    const bump = (tokens, weight) => {
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + weight)
    }
    bump(titleTokens, 4)
    bump(tagTokens, 3)
    bump(catTokens, 2)
    bump(descTokens, 1)

    docTerms.push(counts)
    for (const term of counts.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
  }

  // 只为区分度高的词建倒排：出现在半数以上文档里的词几乎没有筛选力
  const cutoff = Math.max(1, Math.floor(skills.length * 0.5))
  for (const [term, df] of docFreq) {
    if (df > cutoff && term.length <= 2) continue
    postings.set(term, df)
  }

  const total = Math.max(1, skills.length)
  const idf = new Map()
  for (const [term, df] of postings) {
    idf.set(term, Math.log(1 + total / df))
  }

  return { skills, docTerms, idf, size: skills.length }
}

/**
 * 检索最相关的技能。
 *
 * 过滤策略：以相对阈值为主。
 *   - 先剔除得分恰好为 0 的（词汇零重叠）
 *   - 再保留 ≥ 最高分 × `relFloor` 的结果，裁掉长尾
 *
 * 为什么不用绝对下限：分值天然随索引规模变化。
 * 实测 8,803 条语料里相关问题 top 分是 90~480，
 * 而在几十条的小索引上同一个词可能只有 2~3 分——
 * 写死一个数字必然在某一端失效。相对阈值与规模无关。
 * `minScore` 只保留为极端情况下的兜底，默认取 1（几乎不拦任何东西）。
 *
 * 诚实说明其局限：词法匹配无法可靠判断「相关」，只能判断「词汇是否重合」。
 * 调用方应在提示里声明这是关键词匹配结果，而非完整清单。
 *
 * @param {SearchIndex} index
 * @param {string} query
 * @param {number} [k] 返回条数
 * @param {{minScore?: number, relFloor?: number}} [opts]
 * @returns {SearchHit[]}
 */
export function search(index, query, k = 10, opts = {}) {
  const minScore = opts.minScore ?? 1
  const relFloor = opts.relFloor ?? 0.3

  if (!index || index.size === 0) return []
  const terms = tokenize(query, { expand: true })
  if (terms.length === 0) return []

  const seen = new Map()
  for (const term of terms) {
    const weight = index.idf.get(term)
    // 查询里出现多次的词累加权重
    const prev = seen.get(term) ?? 0
    seen.set(term, prev + (weight ?? 0.35))
  }

  const scores = new Float64Array(index.size)
  for (const [term, qw] of seen) {
    const idf = index.idf.get(term) ?? 0.35
    for (let i = 0; i < index.size; i++) {
      const tf = index.docTerms[i].get(term)
      if (tf) scores[i] += qw * idf * (1 + Math.log(tf))
    }
  }

  const all = []
  for (let i = 0; i < index.size; i++) {
    if (scores[i] > 0) {
      const s = index.skills[i]
      all.push({ id: s.id, title: s.title, desc: s.desc, category: s.category, score: scores[i] })
    }
  }
  if (all.length === 0) return []

  // 同分时按 id 排序，保证结果稳定可复现
  all.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  const floor = Math.max(minScore, all[0].score * relFloor)
  return all.filter(h => h.score >= floor).slice(0, k)
}

/**
 * 把检索结果渲染成系统提示里的一段文本。
 * 明示「这些是从站内检索出的真实技能」，并要求模型不要超出这个范围编造。
 *
 * @param {SearchHit[]} hits
 * @param {{maxDesc?: number}} [opts]
 * @returns {string}
 */
export function formatHits(hits, { maxDesc = 110 } = {}) {
  if (!hits.length) return ''
  const lines = hits.map((h, i) => {
    const desc = h.desc.length > maxDesc ? h.desc.slice(0, maxDesc) + '…' : h.desc
    const cat = h.category ? ` [${h.category}]` : ''
    // 必须写全路径：表头声明了 /skills/<id>/，若这里只给 /id/，
    // 模型很可能照抄成坏链接
    return `${i + 1}. ${h.title}${cat} — 路径 /skills/${h.id}/ — ${desc}`
  })
  return `按你的问题从站内检索到的相关技能（路径可直接访问）：
${lines.join('\n')}`
}
