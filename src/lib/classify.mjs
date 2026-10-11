/**
 * Skill 自动分类模块（规则层）
 *
 * 设计要点：
 * 1. 打分制取代「首个命中即返回」——多个分类同时命中时取分数最高者
 * 2. 关键词表按实测盲区扩充；dev 类拆宽（原 dev 命中 code|api|build|test 等，几乎命中一切）
 * 3. 输出置信度，供第二层（AI 分类）筛选待处理条目
 *
 * 纯函数、无网络依赖，loader 与同步脚本共用。
 */

/** @typedef {'dev'|'office'|'design'|'writing'|'data'|'research'|'business'|'education'|'life'|'prompting'} CategoryKey */

/** 分类键顺序即平分时的默认优先级 */
export const CATEGORY_KEYS = /** @type {const} */ ([
  'dev',
  'office',
  'design',
  'writing',
  'data',
  'research',
  'business',
  'education',
  'life',
  'prompting',
])

/**
 * 关键词规则表。
 * weight: 该规则命中时的加分；regex: 匹配文本
 * 说明：关键词统一小写匹配；\b 表示词边界，避免 "canvas" 误命中 "can"
 */
/**
 * 关键词规则表（打分的权重体系）。
 *
 * weight = 该规则命中一次加的分。三档设计：
 *   3 强信号 —— 分类专属、外行人几乎不会用来描述别的场景（如 figma / arxiv / recipe）
 *   2 中信号 —— 相关但常与其它类共现（如 frontend / benchmark）
 *   1 弱信号 —— 极易误命中，仅作微调（如 template / content / tool）
 *
 * 两条硬约束（来自 8797 条真实数据的回放教训）：
 *   1. **同一概念不得出现在两个分类里**。sql / schema / pipeline 曾同时出现在 data 与 dev，
 *      导致两边都被抬高、专有信号反而被压过。现已拆分归属：pipeline→dev，schema/sql→data。
 *   2. **泛化动词必须降权**。code / develop / content / tool 这类词在任何描述里都可能出现，
 *      给 3 分会让 dev 吞掉 algorithmic-art（art w2 < code w3）这类明确的专类条目。
 */
const RULES = {
  office: [
    { weight: 3, regex: /\b(pdf|docx?|pptx?|xlsx?|xls|powerpoint|word)\b/i },
    { weight: 3, regex: /\b(spreadsheet|slide|deck|slideshow|powerpoint)\b/i },
    { weight: 3, regex: /\b(calendar|email|inbox|outlook|excel)\b/i },
    // 办公 SaaS 集成名：这类 skill 描述常混入 pipeline/database 等技术词，
    // 集成名是最可靠的信号（notion / gmail / jira 几乎只出现在办公场景）。
    // 注意 slack 只给 1 分——Slack 生态里有大量非办公类工具（gif / bot / webhook），
    // 给 3 分会把 slack-gif-creator 这类设计类技能误判为办公。
    { weight: 3, regex: /\b(notion|gmail|calendly|asana|trello|confluence)\b/i },
    { weight: 1, regex: /\b(slack|zoom|teams|jira)\b/i },
    { weight: 2, regex: /\b(document|doc|notes?|minutes|agenda|checklist|summary)\b/i },
    { weight: 2, regex: /\b(briefing|brief|status-report|weekly-report)\b/i },
    { weight: 1, regex: /\b(format|form|template)\b/i },
  ],
  design: [
    { weight: 3, regex: /\b(design|designer|figma|sketch|wireframe|prototype|mockup)\b/i },
    { weight: 3, regex: /\b(icon|icons|logo|typography|font|fonts|palette|colou?r-scheme)\b/i },
    { weight: 3, regex: /\b(gif|image|images|photo|photography|illustration|illustrate|svg)\b/i },
    { weight: 3, regex: /\b(art|artwork|canvas|aesthetic|craft)\b/i },
    { weight: 2, regex: /\b(animation|animate|video|render|draw|drawing|paint|ui-kit)\b/i },
    { weight: 2, regex: /\b(css|styling|visual|layout|frontend-ui)\b/i },
  ],
  writing: [
    { weight: 3, regex: /\b(writing|writer|write|blog|essay|copywrit|ghostwrit)\b/i },
    { weight: 3, regex: /\b(newsletter|script|scripts|voiceover|storytelling|manuscript)\b/i },
    { weight: 2, regex: /\b(article|post|posts|edit|editing|proofread|grammar|rewrit|revise)\b/i },
    { weight: 2, regex: /\b(translat|book|books|story|stories|tone|voice)\b/i },
    { weight: 1, regex: /\b(content|draft|seo-copy)\b/i },
  ],
  data: [
    { weight: 3, regex: /\b(analytics|analyse|analyze|analysis|data-science)\b/i },
    { weight: 2, regex: /\b(data|dataset|data-driven)\b/i },
    { weight: 3, regex: /\b(sql|schema|etl|warehouse|query)\b/i },
    { weight: 3, regex: /\b(pandas|numpy|tableau|powerbi|statistic)\b/i },
    { weight: 2, regex: /\b(analytics-tool|metric|metrics|chart|charts|correlation|regression|dashboard)\b/i },
    // graph/visualize 既是 UI 词也是数据词，保留为弱信号
    { weight: 1, regex: /\b(graph|graphs|visuali[sz])\b/i },
    { weight: 1, regex: /\b(stat|stats|excel|spreadsheet|report)\b/i },
  ],
  research: [
    { weight: 3, regex: /\b(research|researcher|paper|papers|arxiv|academic|literature|thesis)\b/i },
    { weight: 3, regex: /\b(survey|surveys|studies|experiment|benchmark|peer-review)\b/i },
    { weight: 2, regex: /\b(scrap|crawl|synthesis|hypothesis|methodology|findings|citation)\b/i },
    { weight: 1, regex: /\b(search|fetch|collect|evidence|review|analyse-sources)\b/i },
  ],
  business: [
    { weight: 3, regex: /\b(market|marketing|sales|business|strategy|strategic)\b/i },
    { weight: 3, regex: /\b(seo|advertis|campaign|pricing|revenue)\b/i },
    // 成本/账单类报表：语义上是经营分析（data）还是财务（business）存在争议，
    // 但 dev 的泛化词（agent/api/token）常把它们吸走，这里给 3 分确保归到经营侧
    { weight: 3, regex: /\b(cost-report|spend|billing|finance|invoice)\b/i },
    { weight: 3, regex: /\b(startup|founder|pitch|investor|fundrais|competitor|ecommerce)\b/i },
    { weight: 2, regex: /\b(customer|brand|growth|conversion|roi|kpi|ads|lead)\b/i },
    { weight: 1, regex: /\b(shop|store|salesperson|negotiat|moneti[sz])\b/i },
  ],
  education: [
    { weight: 3, regex: /\b(teach|teacher|teaching|tutor|tutoring|curriculum|syllabus)\b/i },
    { weight: 3, regex: /\b(course|courses|lesson|lessons|classroom|homework|study-guide)\b/i },
    { weight: 3, regex: /\b(exam|quiz|student|students|flashcard|mnemonic)\b/i },
    { weight: 2, regex: /\b(learn|learning|education|pedagog|grade|grades)\b/i },
  ],
  life: [
    { weight: 3, regex: /\b(health|healthy|fitness|workout|exercise|diet|nutrition)\b/i },
    { weight: 3, regex: /\b(recipe|recipes|cook|cooking|meal|kitchen|baking)\b/i },
    { weight: 3, regex: /\b(travel|itinerary|flight|hotel|vacation)\b/i },
    { weight: 2, regex: /\b(habit|meditat|wellness|mindful|sleep|mental)\b/i },
    { weight: 1, regex: /\b(lifestyle|life|personal|self-care|journal|fitness-routine)\b/i },
  ],
  prompting: [
    { weight: 3, regex: /\b(prompt|prompts|prompting|prompt-engineer)\b/i },
    { weight: 3, regex: /\b(skill-creator|skill-writer|meta-prompt|system-prompt)\b/i },
    { weight: 2, regex: /\b(persona|roleplay|cot|chain-of-thought|instruction)\b/i },
    { weight: 1, regex: /\b(refine|optimi[sz]e|template)\b/i },
  ],
  dev: [
    // 只保留「开发行为本身」的词给 3 分
    { weight: 3, regex: /\b(refactor|debug|debugger|compiler|compilation|build-system|lint)\b/i },
    { weight: 2, regex: /\b(git|github|gitlab|commit|pull-request|rebase|merge-conflict)\b/i },
    { weight: 3, regex: /\b(docker|kubernetes|terraform|ci\/cd|devops|infrastructure)\b/i },
    { weight: 3, regex: /\b(cli|command-line|terminal|shell-script|powershell)\b/i },
    { weight: 3, regex: /\b(vulnerab|exploit|penetrat|owasp|encryption)\b/i },
    { weight: 3, regex: /\b(type-?check|code-?review|unit-?test|integration-?test|api-?design)\b/i },
    // 「编程语言/编程」仍是强信号
    { weight: 2, regex: /\b(programming|coding|codebase|software-engineer)\b/i },
    // 泛化技术栈词压到 1 分：它们只说明「用什么实现」，不说明「做什么」。
    // 实测这些词贡献了 dev 近 40% 的得分，把 orbit-notion（办公集成）、
    // github-dashboard（数据看板）、agent-cost-report（成本报表）全吸进 dev。
    { weight: 1, regex: /\b(code|api|sdk|server|backend|frontend|fullstack|microservice|database|nosql|auth|deploy|developer|development|software|test|testing|compile|repository|repo|mcp|agent|tool|context|pipeline|web-?app)\b/i },
  ],
}
/** @type {Record<CategoryKey, Array<{weight:number, regex:RegExp}>>} */
const RULES_BY_CATEGORY = /** @type {any} */ (RULES)

/**
 * 关键词打分的平分优先级（索引越小越优先）。
 *
 * 刻意与 CATEGORY_KEYS 的顺序区分开：CATEGORY_KEYS 是「页面展示顺序」，
 * 若拿它做平分裁决，dev 会排在最前，平分时全部倒向 dev —— 正是我们要消除的过度集中。
 * 这里按「语义更专一」的分类优先：office/data/design 等有明确信号词的类别先于泛化的 dev。
 */
const TIE_BREAK_PRIORITY = [
  'office',
  'data',
  'design',
  'writing',
  'research',
  'business',
  'education',
  'life',
  'prompting',
  'dev',
]

/**
 * 分类结果
 * @typedef {Object} ClassifyResult
 * @property {CategoryKey} category  最终分类
 * @property {number} confidence    置信度 0-1（1 = frontmatter 显式声明）
 * @property {'declared'|'mapped'|'path'|'keyword'|'fallback'} source 判定来源
 * @property {Record<string, number>} scores 各分类得分（调试用）
 */

/**
 * 主分类函数
 * @param {Object} ctx
 * @param {Record<string, any>} [ctx.frontmatter] skill frontmatter
 * @param {string} [ctx.dirName] 目录名（skill 名）
 * @param {string} [ctx.dir] 相对路径
 * @param {CategoryKey} [ctx.fallback] 最终兜底（默认 dev）
 * @param {Record<string, CategoryKey>} [ctx.categoryMap] 目录名 → 分类映射
 * @returns {ClassifyResult}
 */
export function classifySkill(ctx) {
  const { frontmatter = {}, dirName = '', dir = '', fallback = 'dev', categoryMap = {} } = ctx

  // 1) frontmatter 显式声明（最高优先级，置信度 1.0）
  const declared = typeof frontmatter.category === 'string' ? frontmatter.category.trim() : ''
  if (isCategoryKey(declared)) {
    return { category: declared, confidence: 1, source: 'declared', scores: {} }
  }

  // 2) categoryMap 配置（人工指定，可信度高）
  const mapped = categoryMap[dirName]
  if (typeof mapped === 'string' && isCategoryKey(mapped)) {
    return { category: mapped, confidence: 0.9, source: 'mapped', scores: {} }
  }

  // 3) 路径段命中（如 office/pdf/SKILL.md）
  const segments = dir.split('/').filter(Boolean)
  const pathHit = segments.find(seg => isCategoryKey(seg))
  if (pathHit) {
    return { category: pathHit, confidence: 0.8, source: 'path', scores: {} }
  }

  // 4) 关键词打分
  //
  // 分「名称」与「描述」两路统计，并给名称 2 倍权重。
  // 依据（来自真实数据回放）：skill 目录名往往就是功能名（notion / gif / recipe），
  // 信号密度远高于描述；而描述里混入了大量技术栈词汇（pipeline / database / frontend），
  // 会把与开发无关的 skill 拖进 dev（orbit-notion 这类办公集成被误判为 dev）。
  // 名称是「这个 skill 做什么」，描述里的技术词往往只是「它用什么实现」。
  const nameText = dirName.toLowerCase()
  const descText = buildDescriptionText(frontmatter)
  const scores = {}
  for (const key of CATEGORY_KEYS) {
    let score = 0
    for (const rule of RULES_BY_CATEGORY[key]) {
      if (rule.regex.test(nameText)) score += rule.weight * 2
      if (rule.regex.test(descText)) score += rule.weight
    }
    if (score > 0) scores[key] = score
  }

  const entries = Object.entries(scores)
  if (entries.length === 0) {
    // 全不命中 → 兜底，置信度 0（留给第二层 AI 处理）
    return { category: fallback, confidence: 0, source: 'fallback', scores: {} }
  }

  // 取最高分；平分时按 TIE_BREAK_PRIORITY 裁决（而非遍历顺序）
  const totalScore = entries.reduce((sum, [, s]) => sum + s, 0)
  let best = entries[0]
  for (const entry of entries) {
    if (entry[1] > best[1]) {
      best = entry
    } else if (entry[1] === best[1]) {
      const rankA = TIE_BREAK_PRIORITY.indexOf(entry[0])
      const rankB = TIE_BREAK_PRIORITY.indexOf(best[0])
      if (rankA !== -1 && (rankB === -1 || rankA < rankB)) best = entry
    }
  }

  const confidence = Math.round((best[1] / totalScore) * 100) / 100
  return { category: best[0], confidence, source: 'keyword', scores }
}

/**
 * 判断字符串是否为合法分类键
 * @param {string} value
 * @returns {value is CategoryKey}
 */
export function isCategoryKey(value) {
  return CATEGORY_KEYS.includes(/** @type {CategoryKey} */ (value))
}

/**
 * 构造描述 + 标签的匹配文本（不含目录名，目录名单独按 2 倍权重计算）。
 *
 * 远端 frontmatter 不可信：tags 可能是字符串而非数组，description 可能是数字或对象，
 * 这里统一做类型防御，任何异常字段都退化为空串而不是抛错。
 *
 * @param {Record<string, any>} [frontmatter]
 * @returns {string}
 */
function buildDescriptionText(frontmatter = {}) {
  const parts = []
  const desc = frontmatter.description
  if (typeof desc === 'string') parts.push(desc)
  else if (typeof desc === 'number' || typeof desc === 'boolean') parts.push(String(desc))

  const tags = frontmatter.tags
  if (Array.isArray(tags)) {
    for (const tag of tags) if (typeof tag === 'string') parts.push(tag)
  } else if (typeof tags === 'string') {
    // 脏数据：tags 写成 "a, b" 或单个字符串
    parts.push(tags)
  }

  return parts.filter(Boolean).join(' ').toLowerCase()
}

/**
 * 批量分类（便捷函数）
 * @param {Array<{frontmatter?: Record<string,any>, dirName?: string, dir?: string}>} skills
 * @returns {ClassifyResult[]}
 */
export function classifyBatch(skills) {
  return skills.map(s => classifySkill(s))
}

export { RULES_BY_CATEGORY as RULES }