/**
 * 仓库入库判定：元数据预筛（阶段 1）与轻量文件探测（阶段 2）。
 *
 * 两条贯穿全文件的纪律：
 *
 * 1. **证据不足不等于有问题。** 只有能用现有字段正面证伪时才判 SKIP；
 *    任何需要读文件内容才能确认的规则一律推迟到阶段 2，
 *    阶段 1 不做「猜」。规范也要求：关键字段缺失导致无法判断时输出
 *    REVIEW / MISSING_INFO，而不是硬猜一个 SKIP。
 *
 * 2. **SKIP 是有代价的。** 误抓只是站点多一条内容，误杀是内容凭空消失。
 *    因此所有 SKIP 都要给出可复核的 reason_code，
 *    宁可把可疑项送去 REVIEW 抓最小信息，也不要直接丢弃。
 *
 * 纯函数、无 I/O，便于单测，也便于 CLI 与构建期 loader 共用同一套判定。
 */

/* ------------------------------ 类型 ------------------------------ */

/** 判定结果；与规范要求的 JSON Lines 字段一一对应 */
export interface Verdict {
  decision: 'PASS' | 'REVIEW' | 'SKIP'
  reason_code: string
  reason: string
  confidence: number
}

/** 阶段 1 输入：只用 GitHub API 元数据，不含任何文件内容 */
export interface RepoMeta {
  repo: string
  stars: number
  description?: string
  language?: string | null
  /** archived / fork 在搜索结果里就有，无需额外请求 */
  archived?: boolean
  fork?: boolean
  /** GitHub 探测到的许可证；null = 未探测到 */
  license?: string | null
  last_push?: string
  created_at?: string
  open_issues?: number
  topics?: string[]
  /** 默认分支；阶段 2 拉文件树时需要 */
  default_branch?: string
  /**
   * fork 数。
   *
   * 站点要的「下载次数」在 GitHub 公开 API 里不存在（clone/fetch 数不对外暴露），
   * fork 是最接近「有人真的拿了一份去用」的信号，因此拿它当替代指标。
   */
  forks?: number
  /**
   * 最新 release 时间。
   * undefined = 没查过（未知），null = 查过且没有 release。
   * R2 需要「无 release」这个事实才能成立，所以必须区分这两者。
   */
  latest_release_at?: string | null
}

/** 阶段 2 输入：文件树 + README 前若干字符，不含完整内容 */
export interface RepoProbe {
  /** 完整文件路径列表（仅类型判断，不含内容） */
  paths: string[]
  /** README 前 N 字符（N 默认 2000） */
  readme: string
  /** README 全文长度（判断「只有 README」的占比） */
  readmeLength: number
  /** 命中的 SKILL.md 路径 */
  skillFiles: string[]
  /** references/ 下的文件路径 */
  referenceFiles: string[]
  /** scripts/ 下的文件路径 */
  scriptFiles: string[]
  /** 全部 skill 内容的估算 token（调用方已算好，避免这里重复读文件） */
  totalTokens: number
}

export interface JudgeOptions {
  /** 现在的时间戳（毫秒），便于测试注入 */
  now?: number
  /** README 采样长度 */
  readmeLimit?: number
  /**
   * 缺少许可证时是否放行。
   * 默认 false —— 规范 R5 明确「license 为空」即硬拒绝。
   * 置 true 可用于抢救探测不到许可证但内容确实有价值的仓库。
   */
  allowMissingLicense?: boolean
  /** 已入库仓库集合，用于 S8 重复判定 */
  knownRepos?: Set<string>
  /**
   * 质量门槛（阶段 1 用）。
   * 不传则三项都不启用 —— 保持 `npm run triage` 的行为与规范一致，
   * 由站点侧显式传入。
   */
  quality?: QualityGate
}

/** 阶段 1 的质量门槛，全部可选，不传即不启用 */
export interface QualityGate {
  /** 低于此 star 数直接排除 */
  minStars?: number
  /** 低于此 fork 数直接排除（forks 是 GitHub 公开 API 里最接近「下载量」的信号） */
  minForks?: number
  /** README 没有具体用法示例时是否硬性排除 */
  requireUsageExample?: boolean
}

/* ------------------------------ 阈值 ------------------------------ */

const MONTH_MS = 30 * 4_345_600_000

/** R2 / S1 的停更分界：6~18 个月存疑，超过 18 个月才判硬拒绝 */
const STALE_SOFT_MONTHS = 6
const STALE_HARD_MONTHS = 18
/** R8：skill 内容少于此 token 数视为内容过薄 */
const THIN_TOKENS = 100
/** S2：超过此 token 数且没有 references/ 分层则标记 */
const CONTEXT_HEAVY_TOKENS = 4_000
/** S3：单仓超过此数量的 skill 且描述里没有边界说明则标记 */
const TOO_BROAD_SKILLS = 5

/**
 * 主题相关词。用于 R3「与 AI Skill / Agent 指令 / 编码助手配置无关」。
 *
 * 只收**领域名词**，不收 AI、tool、agent 这类过宽的词 ——
 * "AI" 能匹配到简历生成器、壁纸应用，判不出任何东西。
 */
const TOPIC_TERMS = [
  'skill', 'skills', 'agent', 'agents', 'agentic',
  'claude', 'cursor', 'copilot', 'windsurf', 'codex', 'opencode', 'gemini',
  'mcp', 'model context protocol',
  'prompt', 'prompts', 'prompting', 'system prompt',
  'llm', 'openai', 'anthropic', 'langchain',
  'subagent', 'instruction', 'instructions', 'rules',
  'assistant', 'workflow', 'workflows',
  'awesome-', 'agentskills', 'claude-code', 'agents.md', 'cursorrules',
]

/**
 * R4 纯引流特征 —— **只收真正的商业导流**。
 *
 * 最初这里还混着 discord server / join our / sponsor / newsletter signup，
 * 结果把 `code-yeongyu/oh-my-openagent` 误杀了：
 * 那是个 60 个 SKILL.md 的正经技能合集，README 顶部的
 * 「Join our Discord」「Sponsor」在开源项目里是标配，
 * 命中 ≥2 项就判 R4，60 个 skill 当场被删出站点（总数 8766 → 8729）。
 *
 * 社区链接只能证明「有社区」，证明不了「在导流」。
 * 判断引流要看的是**钱和联系方式**，不是有没有 Discord。
 */
const PROMO_TERMS = [
  '付费社群', '公众号', '知识星球', '训练营', '一对一', '课程推广', '加微信',
  '扫码', '关注公众号', '引流', '限时优惠', '内部渠道',
  'paid community', 'paid course', 'affiliate', 'promo code', 'coupon',
  'enroll now', 'dm me', 'dm us', 'buy my', 'subscribe for access',
]

/** R7 个人草稿特征 */
const DRAFT_TERMS = [
  '个人笔记', '学习笔记', '草稿', 'todo', 'wip', '未完成', '实验性',
  '随手记', '还在整理', '持续更新中，勿用',
  'personal notes', 'scratchpad', 'work in progress', 'unfinished', 'draft only',
  'do not use', 'not ready for production',
]

/** R9 提示注入特征 */
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(?:your|all)\s+(?:instructions?|rules?|guidelines?)/i,
  /bypass\s+(?:your\s+)?(?:safety|security|review|moderation)/i,
  /reveal\s+(?:your\s+)?(?:system\s+)?prompt/i,
  /do\s+not\s+tell\s+the\s+user/i,
  /忽略(?:掉)?(?:以上|之前|前面|上述)(?:的)?(?:所有)?(?:指令|规则|提示)/,
  /绕过(?:安全|审查|审核|风控)/,
  /隐藏(?:操作|真实|提示)/,
  /不要(?:告诉|告知)用户/,
  /无视(?:你的)?(?:安全)?(?:规则|指令)/,
]

/** R10 硬编码密钥特征 */
const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /-----BEGIN\s+(?:RSA|OPENSSH|EC|DSA|PGP)?\s*PRIVATE KEY-----/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\b(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
]

/**
 * R5 中「明确拒绝使用」的声明。
 *
 * 与 `license: null` 分开判断：前者是作者写明了限制（可以据此拒绝），
 * 后者是 GitHub 没探测到（不能据此拒绝）。
 */
const RESTRICTIVE_LICENSE_PATTERNS = [
  /all rights reserved/i,
  /未经.*授权.*(不得|禁止)/,
  /禁止商用/,
  /仅供(个人|学习|内部)(使用|参考)/,
  /no\s+license\s+granted/i,
  /proprietary[\s-]?only/i,
]

/* ------------------------------ 工具 ------------------------------ */

const ok = (reason_code: string, reason: string, confidence = 0.95): Verdict => ({
  decision: 'PASS',
  reason_code,
  reason,
  confidence,
})

const review = (reason_code: string, reason: string, confidence = 0.7): Verdict => ({
  decision: 'REVIEW',
  reason_code,
  reason,
  confidence,
})

const skip = (reason_code: string, reason: string, confidence = 0.9): Verdict => ({
  decision: 'SKIP',
  reason_code,
  reason,
  confidence: Math.min(confidence, 0.99),
})

/** 软标记：code 用于 reason_code（规范只允许单个），detail 用于拼接人读原因 */
interface SoftFlag {
  code: string
  detail: string
  /**
   * 是否降级为 REVIEW。
   *
   * false = 只记录、不改变判定。用于那些在本项目语境下
   * **几乎没有区分度**的标记 —— 实测 30 个真实仓库的抽样里，
   * S7 星数异常命中 13 个（全是头部大仓），拿它当降级依据会误伤主力内容源。
   */
  degrades: boolean
}

/**
 * 多个软标记共存时的收敛。
 *
 * reason_code 字段只能放一个，取**第一条会降级的**标记；
 * 若没有标记会降级，则保持 PASS，但 reason 里仍列出全部标记，
 * 这样日志能看出「有存疑点，只是不足以拦下来」。
 */
const toReview = (flags: SoftFlag[]): Verdict => {
  const blocking = flags.find(f => f.degrades)
  if (!blocking) {
    if (flags.length === 0) return ok('OK', '轻量探测通过', 0.9)
    return {
      decision: 'PASS',
      // 记录性标记也要能出现在 reason_code 里，否则日志里看不到
      reason_code: flags[0].code,
      reason: `${flags.map(f => f.detail).join('；').slice(0, 60)}（仅记录，不降级）`,
      confidence: 0.75,
    }
  }
  return review(blocking.code, flags.map(f => f.detail).join('；').slice(0, 60), 0.6)
}

/** 月龄；created_at 缺失时返回 null */
export function ageMonths(meta: RepoMeta, now = Date.now()): number | null {
  if (!meta.created_at) return null
  const born = Date.parse(meta.created_at)
  if (!Number.isFinite(born)) return null
  return Math.max(0, (now - born) / MONTH_MS)
}

/** 距上次推送的月数；缺失返回 null */
export function idleMonths(meta: RepoMeta, now = Date.now()): number | null {
  if (!meta.last_push) return null
  const pushed = Date.parse(meta.last_push)
  if (!Number.isFinite(pushed)) return null
  return Math.max(0, (now - pushed) / MONTH_MS)
}

/**
 * 估算 token 数。
 *
 * CJK 按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token。
 * 纯粗估：用途是区分「几十 token 的空壳」与「几千 token 的完整方法论」，
 * 精度到个位数没有意义。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[㐀-䶿一-鿿豈-﫿぀-ヿ]/g) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

const hasTopicSignal = (text: string): boolean => {
  const lower = text.toLowerCase()
  return TOPIC_TERMS.some(term => lower.includes(term))
}

const countTerms = (text: string, terms: string[]): number => {
  const lower = text.toLowerCase()
  return terms.filter(term => lower.includes(term)).length
}

/** 命中术语占用的字符数，用于估算「引流内容在 README 里占多大篇幅」 */
const countTermChars = (text: string, terms: string[]): number => {
  const lower = text.toLowerCase()
  let total = 0
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(term, from)
      if (at < 0) break
      total += term.length
      from = at + term.length
    }
  }
  return total
}

/** 找第一个命中的敏感模式，返回命中的特征名（便于写进 reason） */
function matchAny(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[0].slice(0, 24)
  }
  return null
}

/** README 是否含可操作的实质内容：代码块、参数表、具体步骤 */
function hasSubstantiveInstructions(readme: string): boolean {
  if (!readme) return false
  const fenced = /```/.test(readme)
  const heading = /^#{2,3}\s+\S/m.test(readme)
  const numbered = /^\s*\d+\.\s+\S/m.test(readme)
  const install = /\b(npm|pip|brew|uv |cargo|go get|docker|claude code|cursor)\b/i.test(readme)
  return fenced || heading || numbered || install
}

/**
 * README 是否给出了**具体用法示例**。
 *
 * 比 hasSubstantiveInstructions 严：那个只要有标题就算「有内容」，
 * 是给 R1 兜底用的；这里要的是读者看完知道「怎么用」。
 *
 * 认可四种形式，任一即可：
 *   1. 代码块（bash / json / yaml / 实际调用）
 *   2. 明确的安装或调用命令
 *   3. 编号步骤
 *   4. frontmatter / 参数说明块（Agent Skills 的标准展示方式）
 *
 * 刻意**不认**这些：只有宣传语、只有徽章、只有目录链接。
 */
function hasUsageExample(readme: string): boolean {
  if (!readme) return false

  // 1) 代码块 —— 排除空块与纯输出示例
  if (/```[a-z]*\n\s*\S/.test(readme)) return true

  // 2) 安装 / 调用命令
  if (/^\s*(?:\$|>)\s*(?:npm|pip|pipx|uv|pip3|brew|cargo|go|docker|claude|npx|git)\b/im.test(readme)) return true
  if (/```(?:bash|sh|shell|console|shell-session)\s*\n[^`\n]*\b(?:npm|pip|install|run|claude|uv)\b/i.test(readme)) {
    return true
  }

  // 3) 编号步骤
  if (/^\s*\d+[.)]\s+\S/m.test(readme)) return true

  // 4) Agent Skills 的 frontmatter 示例
  if (/^---\r?\n\s*(?:name|description)\s*:/m.test(readme)) return true

  return false
}

/** description 是否像营销话术：只有形容词，没有「解决什么问题 / 怎么触发」 */
function isMarketingOnly(readme: string): boolean {
  if (!readme) return true
  if (hasSubstantiveInstructions(readme)) return false
  return /(powerful|seamless|revolutionary|ultimate|best-in-class|一句话|最强|革命性|一站式)/i.test(readme)
}

/* -------------------------- 阶段 1：元数据预筛 -------------------------- */

/**
 * 只用元数据做预筛，不读取任何文件内容。
 *
 * 判定顺序即规范的顺序：先硬拒绝（命中即停），再软标记，最后放行到阶段 2。
 * 需要文件内容才能确认的规则（R1 / R7 / R8 与部分 R4/R9/R10）在这里一律不下结论。
 */
export function judgeMetadata(meta: RepoMeta, opts: JudgeOptions = {}): Verdict {
  const now = opts.now ?? Date.now()
  const desc = meta.description ?? ''
  const topics = meta.topics ?? []
  const pending: SoftFlag[] = []
  const idle = idleMonths(meta, now)

  /* --- 质量门槛（站点侧启用；triage CLI 不传即不生效） --- */
  const gate = opts.quality
  if (gate?.minStars != null && meta.stars < gate.minStars) {
    return skip('Q1', `${meta.stars}★ 低于门槛 ${gate.minStars}★`, 0.95)
  }
  if (gate?.minForks != null && (meta.forks ?? 0) < gate.minForks) {
    return skip('Q2', `${meta.forks ?? 0} fork 低于门槛 ${gate.minForks}`, 0.9)
  }

  /* --- R2 归档：字段明确，证据充分 --- */
  if (meta.archived === true) {
    return skip('R2', '仓库已归档', 0.99)
  }

  /* --- R6 无增量 fork --- */
  if (meta.fork === true) {
    return skip('R6', 'fork 仓库，元数据阶段无法确认独立增量', 0.75)
  }

  /* --- R5 许可证 --- */
  /*
   * 规范原文是「license 为空 → 硬拒绝」。实测这条会误杀主力内容源：
   * 30 个真实仓库抽样里命中 2 个，其中 ComposioHQ/awesome-claude-skills
   * 缓存里有 200 个 skill。
   *
   * 原因是 GitHub 的 licensee 对很多有效许可证**探测不出来**
   * （LICENSE 在非常规位置、或仓库里有多份冲突的许可文件），
   * `license: null` 表达的是「不知道」，不是「禁止使用」。
   * 把「不知道」当成「禁止」会直接丢掉内容，代价远大于收益。
   *
   * 因此改为：未探测到 → 降级 REVIEW；
   * 只有**明确声明限制**才硬拒绝（RESTRICTIVE_LICENSE_PATTERNS）。
   */
  if (!meta.license && !opts.allowMissingLicense) {
    const restrictive = matchAny(`${desc} ${topics.join(' ')}`, RESTRICTIVE_LICENSE_PATTERNS)
    if (restrictive) return skip('R5', `许可证声明限制使用「${restrictive}」`, 0.85)
    pending.push({ code: 'R5', detail: '未探测到许可证（可能只是探测不到）', degrades: true })
  }

  /* --- R2 长期停更：需要「无 release」这个事实才能成立 --- */
  if (idle != null && idle > STALE_HARD_MONTHS) {
    if (meta.latest_release_at === undefined) {
      // 没查过 release：不能凭猜测丢掉一个可能仍在发版维护的仓库
      return review('MISSING_INFO', `停更 ${Math.round(idle)} 个月，未查证是否有 release`, 0.5)
    }
    const releaseAge = (() => {
      if (!meta.latest_release_at) return Number.POSITIVE_INFINITY
      const at = Date.parse(meta.latest_release_at)
      return Number.isFinite(at) ? (now - at) / MONTH_MS : Number.POSITIVE_INFINITY
    })()
    if (releaseAge > STALE_HARD_MONTHS) {
      return skip('R2', `停更 ${Math.round(idle)} 个月且无新 release`, 0.9)
    }
  }

  /* --- description 上的注入与密钥：命中即硬拒绝，不需要读文件 --- */
  if (desc) {
    const injection = matchAny(desc, INJECTION_PATTERNS)
    if (injection) return skip('R9', `描述含提示注入特征「${injection}」`, 0.85)
    const secret = matchAny(desc, SECRET_PATTERNS)
    if (secret) return skip('R10', '描述含疑似硬编码密钥', 0.8)
  }

  /* --- R4 纯引流：描述级引流且完全无主题信号才判硬拒绝 --- */
  const promoHits = countTerms(desc, PROMO_TERMS)
  const topicHit = hasTopicSignal(`${meta.repo} ${desc} ${topics.join(' ')}`)
  if (promoHits >= 2 && !topicHit) {
    return skip('R4', `描述以引流为主且无主题信号（命中 ${promoHits} 项）`, 0.75)
  }

  /* --- R3 主题无关：描述非空但完全没有领域名词 --- */
  if (desc && !topicHit) {
    return skip('R3', '描述与 AI Skill / Agent 指令无关', 0.7)
  }

  /* --- 关键字段缺失 --- */
  if (idle == null) {
    return review('MISSING_INFO', '缺少 last_push，无法判断维护状态', 0.5)
  }

  /* --- 软标记：不停流程，只在必要时降级 --- */

  // S1 维护性存疑：6~18 个月没动，且有未处理 issue
  if (idle > STALE_SOFT_MONTHS && (meta.open_issues ?? 0) > 0) {
    pending.push({
      code: 'S1',
      detail: `停更${Math.round(idle)}月且有${meta.open_issues}个未关闭issue`,
      degrades: true,
    })
  }

  // S7 星数异常：只记录，不降级 —— 说明见 SoftFlag.degrades
  const age = ageMonths(meta, now)
  if (age != null && age > 0 && age < 3 && meta.stars >= 5_000) {
    pending.push({
      code: 'S7',
      detail: `建成${age.toFixed(1)}月即${meta.stars}星，星数增速异常`,
      degrades: false,
    })
  }

  // S4 效果存疑：描述只有营销话术。只记录 —— 描述写得短不代表 skill 差
  if (desc && isMarketingOnly(desc) && !hasSubstantiveInstructions(desc)) {
    pending.push({ code: 'S4', detail: '描述疑似只有营销话术', degrades: false })
  }

  // S6 来源不明：无描述、无主题、无组织信息。只记录
  if (!desc && topics.length === 0) {
    pending.push({ code: 'S6', detail: '描述与主题均为空，来源无法追溯', degrades: false })
  }

  return toReview(pending)
}

/* -------------------------- 阶段 2：轻量探测 -------------------------- */

/**
 * 拿到文件树与 README 前若干字符后的确认判定。
 *
 * stage1 是本函数的入参之一：阶段 1 已经判出的软标记要保留，
 * 这里只做增量确认，不推翻阶段 1 的硬拒绝（真要推翻也应重新走流程）。
 */
export function judgeProbe(probe: RepoProbe, stage1: Verdict, opts: JudgeOptions = {}): Verdict {
  if (stage1.decision === 'SKIP') return stage1

  const readme = probe.readme ?? ''
  const flags: SoftFlag[] = []

  /* --- 质量门槛：README 必须给出具体用法示例 --- */
  if (opts.quality?.requireUsageExample === true && !hasUsageExample(readme)) {
    return skip('Q3', 'README 没有可照做的用法示例', 0.8)
  }

  /* --- R9 / R10：内容里的注入与密钥 --- */
  const injection = matchAny(readme, INJECTION_PATTERNS)
  if (injection) return skip('R9', `README 含提示注入「${injection}」`, 0.9)
  const secret = matchAny(readme, SECRET_PATTERNS)
  if (secret) return skip('R10', 'README 含疑似硬编码密钥', 0.9)

  /* --- R1 空壳：无 SKILL.md，或只有 README 且无实质指令 --- */
  if (probe.skillFiles.length === 0) {
    // 仓库里可能有其它可复用资产，但本站只收 SKILL.md；
    // 若 README 有实质指令且体量可观，仍交给 REVIEW 抓摘要而不是直接丢。
    if (!hasSubstantiveInstructions(readme) || probe.readmeLength < 400) {
      return skip('R1', '无 SKILL.md 且 README 无实质指令', 0.95)
    }
    return review('MISSING_INFO', '无 SKILL.md，但 README 含实质内容', 0.5)
  }

  /* --- R8 内容过薄 --- */
  /*
   * totalTokens < 0 表示「算不出来」（调用方拿不到文件大小也没缓存正文）。
   * 此时必须跳过 R8 —— 把「未知」当「内容为空」会把好仓库整批误杀。
   * 纪律上与 MISSING_INFO 一致：信息不足就不下结论。
   */
  if (probe.totalTokens >= 0 && probe.totalTokens < THIN_TOKENS) {
    return skip('R8', `skill 内容约 ${probe.totalTokens} token，少于 ${THIN_TOKENS}`, 0.9)
  }
  if (probe.totalTokens < 0) {
    flags.push({ code: 'MISSING_INFO', detail: '无法估算内容体量，跳过 R8 判定', degrades: false })
  }

  /* --- R4 纯引流：README 以引流为主 --- */
  /*
   * 光靠「命中 ≥2 项」不够 —— README 里塞一句推广语就够凑数。
   * 加一层篇幅占比：引流必须**占住 README 的相当部分**才叫「以引流为主」，
   * 否则那些只在开头放一行推广、其余全是正经文档的仓库会被误杀。
   */
  const promoHits = countTerms(readme, PROMO_TERMS)
  const promoChars = countTermChars(readme, PROMO_TERMS)
  const promoShare = probe.readmeLength > 0 ? promoChars / probe.readmeLength : 0
  if (promoHits >= 2 && promoShare >= 0.08) {
    return skip('R4', `README 约 ${(promoShare * 100).toFixed(0)}% 是课程/社群导流`, 0.8)
  }

  /* --- R7 个人草稿 --- */
  const draftHits = countTerms(readme, DRAFT_TERMS)
  if (draftHits >= 2) {
    return skip('R7', `README 自述为草稿/个人笔记（命中 ${draftHits} 项）`, 0.8)
  }

  /* --- S2 上下文成本高 --- */
  if (probe.totalTokens > CONTEXT_HEAVY_TOKENS && probe.referenceFiles.length === 0) {
    flags.push({
      code: 'S2',
      detail: `内容约${probe.totalTokens}token且无 references/ 分层`,
      degrades: true,
    })
  }

  /* --- S3 职责过宽 --- */
  if (probe.skillFiles.length > TOO_BROAD_SKILLS) {
    flags.push({
      code: 'S3',
      detail: `单仓 ${probe.skillFiles.length} 个 skill，职责边界不明`,
      degrades: true,
    })
  }

  /* --- S5 依赖不明：带脚本但 README 没说依赖/权限 --- */
  if (
    probe.scriptFiles.length > 0 &&
    !/\b(npm|pip|uv |brew|cargo|requirements|package\.json|pyproject|docker|environment|env\b)/i.test(readme)
  ) {
    flags.push({
      code: 'S5',
      detail: `含 ${probe.scriptFiles.length} 个脚本但未说明依赖与运行环境`,
      degrades: true,
    })
  }

  /* --- S4 效果存疑：只记录 --- */
  if (isMarketingOnly(readme)) {
    flags.push({ code: 'S4', detail: 'README 无具体用法或示例', degrades: false })
  }

  /* --- S8 重复条目：skill 路径与库内已有条目撞车 --- */
  if (opts.knownRepos && opts.knownRepos.size > 0) {
    const dupes = probe.skillFiles.filter(file => opts.knownRepos.has(file.toLowerCase()))
    if (dupes.length > 0) {
      flags.push({ code: 'S8', detail: `${dupes.length} 个 skill 路径与库内条目重复`, degrades: true })
    }
  }

  return toReview(flags)
}

/* -------------------------- 抓取内容规划 -------------------------- */

/**
 * 按判定结果规划抓取范围（规范的「抓取内容规范」）。
 *
 * scripts/ 只列文件名不取内容，除非调用方显式要求 ——
 * 本站会把内容渲染成页面并在聊天窗里送给模型，
 * 执行脚本不是入库的前提，也是一类不必要的风险。
 */
export function planFetch(
  verdict: Verdict,
  probe?: RepoProbe,
  options: { includeScriptContent?: boolean; referenceFileLimit?: number } = {},
): {
  fetched: boolean
  maxFiles: number
  referenceFileLimit: number
  readmeLimit: number
  includeScriptContent: boolean
} {
  if (verdict.decision === 'SKIP') {
    return {
      fetched: false,
      maxFiles: 0,
      referenceFileLimit: 0,
      readmeLimit: 0,
      includeScriptContent: false,
    }
  }
  if (verdict.decision === 'REVIEW') {
    return {
      fetched: true,
      /**
       * REVIEW 要交出**文件树**（规范：「只抓取元数据 + README 前 2000 字符 + 文件树」），
       * 所以 skill 路径要列全。列路径 ≠ 下载正文 ——
       * 是否真正下载由调用方按 decision 决定，两者不该用同一个开关控制。
       */
      maxFiles: Number.POSITIVE_INFINITY,
      referenceFileLimit: 0,
      // REVIEW 只取 README 摘要，不取任何完整内容文件
      readmeLimit: 2000,
      includeScriptContent: false,
    }
  }
  const refLimit = options.referenceFileLimit ?? 5
  const referenceFiles = probe?.referenceFiles ?? []
  return {
    fetched: true,
    /**
     * PASS 仓要抓 references/ 下的关键文件，上限默认 5 个（规范上限）。
     * 用 maxFiles 而非 truncate，是为了让调用方保留「有多少超了」的信息，
     * 由它决定是截断还是告警。
     */
    maxFiles: Math.min(referenceFiles.length, refLimit),
    referenceFileLimit: refLimit,
    readmeLimit: Number.POSITIVE_INFINITY,
    includeScriptContent: options.includeScriptContent === true,
  }
}

/** 把判定与元数据合成规范要求的 JSON Lines 单行 */
export function toJsonLine(
  meta: RepoMeta,
  verdict: Verdict,
  fetchedFiles: string[] = [],
): string {
  return JSON.stringify({
    repo: meta.repo,
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    reason: verdict.reason,
    confidence: Number(verdict.confidence.toFixed(2)),
    fetched: fetchedFiles.length > 0,
    fetched_files: fetchedFiles,
    metadata: {
      stars: meta.stars,
      last_push: meta.last_push?.slice(0, 10) ?? null,
      license: meta.license ?? null,
      description: meta.description ?? '',
    },
  })
}