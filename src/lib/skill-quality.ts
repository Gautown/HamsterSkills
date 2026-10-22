/**
 * 技能级质量判定（第三级入库判定）：仓库已通过之后，判断**单个 SKILL.md** 是否值得上站。
 *
 * 为什么需要：
 *   仓库级质量门槛（triage.ts 的 Q1-Q3）只能回答「这个仓值不值得抓」，
 *   回答不了「仓里的每个 SKILL.md 本身是否可用」。2026-10 全量分析
 *   6181 条在站技能发现 1377 条属于四类问题：符号链接指针（正文就是
 *   一行 "../x/SKILL.md" 路径文本）、正文过薄（含 "First skill" 这类
 *   测试残留）、无 frontmatter.description、跨仓纯重复。
 *
 * 纪律（与 triage.ts 相同，判定事故的代价是内容凭空消失）：
 *   1. **证据不足不判 SKIP。** 只判能用现有字段正面证伪的
 *      （正文长度、描述缺失、byte 级重复）；拿不准的一律放行。
 *   2. **阈值全部可调，缺省不启用。** 由 content.config.ts 显式传入；
 *      `npm run triage` 等离线工具不传即完全不受影响。
 *   3. **纯函数、无 I/O。** 判定错误只能靠单测拦住 ——
 *      scripts/skill-quality.test.mjs 逐条钉死边界语义。
 */

/* ------------------------------ 类型 ------------------------------ */

/**
 * 技能级判定码（与仓库级 R/Q/S 体系并列）：
 *   SK1 正文过薄      body 字符数 < minBodyChars
 *   SK2 缺少描述      frontmatter.description 缺失或空白（requireDescription 开启时）
 *   SK3 跨仓重复      与先处理的技能同 sha，或规范化描述完全相同
 *   SK4 整仓近全废    仓内未通过 SK1/SK2 的占比严格大于 repoJunkRatio，整仓剔除
 */
export type SkillGateCode = 'SK1' | 'SK2' | 'SK3' | 'SK4'

/** 判定所需的单个技能最小信息集（都来自已抓取的缓存，零额外请求） */
export interface SkillCandidate {
  id: string
  repo: string
  sha: string
  /** 去掉 frontmatter 后的 Markdown 正文 */
  body: string
  frontmatter: Record<string, unknown>
}

/** 技能级门槛配置；全部可选，缺省即不启用该项 */
export interface SkillGateOptions {
  /**
   * 正文（不含 frontmatter）字符数下限。
   * 严格小于该值判 SK1。undefined = 不启用。
   */
  minBodyChars?: number
  /**
   * 是否要求 frontmatter.description 非空（trim 后）。
   * 缺失/空白/非字符串都算缺失。undefined = 不启用。
   */
  requireDescription?: boolean
  /**
   * 仓内「近全废」剔除比例（0-1 之间）。
   * 未通过技能占比**严格大于**该值时整仓剔除（0.9 表示 >90%）。
   * 边界语义刻意用「严格大于」：恰好 90% 不剔除，
   * 避免阈值附近的仓库在两次构建间因一条技能增减来回横跳。
   * undefined = 不启用。
   */
  repoJunkRatio?: number
}

/** 单个技能的判定结果 */
export interface SkillVerdict {
  decision: 'PASS' | 'SKIP'
  /** PASS 时为 'OK' */
  code: 'OK' | SkillGateCode
  /** 给日志/审计看的中文原因；PASS 时为空串 */
  reason: string
}

/** 整仓结论 */
export interface RepoGateOutcome {
  drop: boolean
  /** 未通过占比（0-1）；未启用或空仓时为 0 */
  ratio: number
  reason: string
}

/* ------------------------------ 单项判定 ------------------------------ */

/** 取 frontmatter 里可用的描述文本：非字符串 / 空白都视为缺失 */
export function descriptionOf(frontmatter: Record<string, unknown>): string | null {
  const value = frontmatter.description
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * 单个技能判定。
 * 顺序：先 SK1（正文）后 SK2（描述）—— 正文过薄时描述问题不再重复报告。
 */
export function judgeSkill(candidate: SkillCandidate, options: SkillGateOptions): SkillVerdict {
  const { minBodyChars, requireDescription } = options

  if (minBodyChars != null && candidate.body.length < minBodyChars) {
    return {
      decision: 'SKIP',
      code: 'SK1',
      reason: `正文仅 ${candidate.body.length} 字符（下限 ${minBodyChars}）`,
    }
  }

  if (requireDescription === true && descriptionOf(candidate.frontmatter) === null) {
    return {
      decision: 'SKIP',
      code: 'SK2',
      reason: '缺少 frontmatter.description（描述会退化成目录名拼接）',
    }
  }

  return { decision: 'PASS', code: 'OK', reason: '' }
}

/* ------------------------------ 整仓判定 ------------------------------ */

/**
 * 整仓结论：把该仓全部候选技能的 verdicts 汇总，占比超过阈值即整仓剔除。
 *
 * 只在「提交之前」调用 —— 命中剔除的仓，其未通过项与通过项一起消失。
 * 未启用（ratio 为 undefined）或没有任何候选时一律不剔除。
 */
export function judgeRepoOutcome(verdicts: SkillVerdict[], repoJunkRatio: number | undefined): RepoGateOutcome {
  if (repoJunkRatio == null || verdicts.length === 0) {
    return { drop: false, ratio: 0, reason: '' }
  }
  const failed = verdicts.filter(v => v.decision === 'SKIP').length
  const ratio = failed / verdicts.length
  if (ratio > repoJunkRatio) {
    return {
      drop: true,
      ratio,
      reason: `${failed}/${verdicts.length} 个技能未通过技能级门槛（${(ratio * 100).toFixed(0)}% > ${(repoJunkRatio * 100).toFixed(0)}%）`,
    }
  }
  return { drop: false, ratio, reason: '' }
}

/* ------------------------------ 跨仓去重 ------------------------------ */

/**
 * 规范化描述文本，作为「重复」的判据。
 *
 * 小于 30 字符的描述（"Changelog" 之类）返回 null —— 这么短的字符串
 * 撞车不能作为重复证据（不同技能恰好同名完全正常），宁可漏并不可错并。
 */
export function normalizeDesc(description: string): string | null {
  const normalized = description.trim().toLowerCase().replace(/\s+/g, ' ')
  return normalized.length >= 30 ? normalized : null
}

/**
 * 跨仓去重过滤器（有状态，作用于整个构建）。
 *
 * 语义：**保首个**。处理顺序 = 显式配置仓库在前、其余按 star 降序，
 * 因此「先到」天然是更权威的来源（如 anthropics 原件先于第三方副本）。
 * 被拒的第二个及之后返回 false，由调用方记为 SK3。
 */
export function createDedupeFilter(): { accept: (sha: string, description: string) => boolean } {
  const seenSha = new Set<string>()
  const seenDesc = new Set<string>()
  return {
    accept(sha: string, description: string): boolean {
      const key = normalizeDesc(description)
      if (seenSha.has(sha) || (key !== null && seenDesc.has(key))) return false
      seenSha.add(sha)
      if (key !== null) seenDesc.add(key)
      return true
    },
  }
}
