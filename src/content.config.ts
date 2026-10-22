import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'
import { loadEnv } from 'vite'
import { combine } from './loaders/combine'
import { githubSkills, type RemoteRepo } from './loaders/github-skills'
import type { CategoryKey } from './lib/categories'

const categories = [
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
] as const

/**
 * 显式 GitHub 聚合源（Agent Skills 标准格式：<目录>/SKILL.md）。
 * 环境变量：
 *  - SKILLS_REPOS="owner/repo[:category],..." 追加显式仓库
 *  - SKILLS_DISCOVER=0 关闭自动发现（默认开启，见下方 discover 配置）
 */
const remoteRepos: RemoteRepo[] = [
  {
    repo: 'anthropics/skills',
    path: 'skills',
    skip: ['template'],
    category: 'dev',
    categoryMap: {
      pdf: 'office',
      docx: 'office',
      pptx: 'office',
      xlsx: 'office',
      'brand-guidelines': 'design',
      'canvas-design': 'design',
      'frontend-design': 'design',
      'theme-factory': 'design',
      'algorithmic-art': 'design',
      'slack-gif-creator': 'design',
      'internal-comms': 'writing',
      'doc-coauthoring': 'writing',
      'academy-guide': 'education',
      'skill-creator': 'prompting',
      'mcp-builder': 'dev',
      'claude-api': 'dev',
      'webapp-testing': 'dev',
      'web-artifacts-builder': 'dev',
      'discernment-nudge': 'life',
    },
  },
  {
    // Hermes Agent（Nous Research）核心仓库：内置技能库，兼容 agentskills.io 开放标准
    repo: 'NousResearch/hermes-agent',
    branch: 'main',
    category: 'dev',
    strict: false,
    // 该仓库内置 211 个 skill，放宽单仓上限以完整收录
    maxSkills: 300,
  },
  {
    // OpenCode（开源编码 agent）核心仓库（默认分支为 dev）
    repo: 'anomalyco/opencode',
    branch: 'dev',
    category: 'dev',
    strict: false,
  },
  {
    // Hermes Agent 社区技能合集（SEO / WordPress / 营销等）
    repo: 'RobinBeraud/hermes-skills',
    branch: 'main',
    category: 'dev',
    strict: false,
  },
]

// 支持 .env / .env.[mode]（真实环境变量优先）
const env = { ...loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), ''), ...process.env }

const envRepos: RemoteRepo[] = (env.SKILLS_REPOS ?? '')
  .split(',')
  .map(part => part.trim())
  .filter(Boolean)
  .map(part => {
    const [repo, category] = part.split(':').map(segment => segment.trim())
    const base = remoteRepos.find(item => item.repo === repo)
    return {
      ...(base ?? { repo }),
      repo,
      ...(category ? { category: category as CategoryKey } : {}),
    }
  })

/** 显式配置的仓库（默认严格：失败即报错；仓库可用 strict: false 放宽） */
const explicitRepos = [...remoteRepos, ...envRepos]

const readNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * 读门槛值；**未设置时返回 undefined（表示不启用该项）**，
 * 而不是回落成某个默认数字 —— 门槛关掉必须是显式行为。
 */
const readOptionalNumber = (value: string | undefined, fallback: number | undefined): number | undefined => {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * 读「比例」配置（0-1）。
 *
 * 与 readOptionalNumber 的差异：**0 表示显式关闭，返回 undefined**。
 * 原因是危险的语义歧义：repoJunkRatio=0 字面含义是「有垃圾就整仓剔除」，
 * 误传给全部仓库会瞬间清空站点；把 0 定义为关闭，让运维意图无歧义。
 */
const readOptionalRatio = (value: string | undefined, fallback: number): number | undefined => {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  if (parsed === 0) return undefined
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const discoveryTopics = (
  env.SKILLS_TOPICS ?? 'agent-skills,claude-skills,claude-code-skills,opencode-skills,opencode-skill,hermes-skills'
)
  .split(',')
  .map(topic => topic.trim())
  .filter(Boolean)

const skills = defineCollection({
  // 本地 Markdown + 远端聚合（显式仓库 + 自动发现）写入同一集合
  // 冲突策略：本地优先；远端之间按显式配置 → star 顺序，先到先得
  loader: combine(
    glob({ pattern: '**/*.md', base: './src/content/skills' }),
    githubSkills({
      repos: explicitRepos,
      discover: {
        enabled: env.SKILLS_DISCOVER !== '0',
        topics: discoveryTopics,
        minStars: readNumber(env.SKILLS_MIN_STARS, 0),
        // 发现上限 300：覆盖 OpenCode / Hermes 生态（低星尾部仓库仍在列表内）
        maxRepos: readNumber(env.SKILLS_MAX_REPOS, 300),
        ttlHours: readNumber(env.SKILLS_DISCOVER_TTL_HOURS, 24),
        exclude: explicitRepos.map(item => item.repo),
        /*
         * 质量门槛：三项都可用环境变量调，缺省即不启用。
         *
         * 阈值是按真实分布定的，不是拍脑袋：
         *   357 个候选里 stars>=100 砍掉 25%、forks>=100 砍掉 46%；
         *   而「star≥3000 但 fork<100」的只有 1 个仓，
         *   「star≥1000 但 fork<10」的一个都没有 ——
         *   fork 在这个生态里与 star 高度相关，拿它当「下载量」替代指标是稳的。
         *
         * 曾按字面取 forks>=1000，实测会砍掉 82% 的仓库（含大量优质合集），
         * 故下调到 100。
         */
        quality: {
          minStars: readOptionalNumber(env.SKILLS_MIN_QUALITY_STARS, 100),
          minForks: readOptionalNumber(env.SKILLS_MIN_QUALITY_FORKS, 100),
          requireUsageExample: env.SKILLS_REQUIRE_USAGE_EXAMPLE !== '0',
        },
      },
      perRepoMaxSkills: readNumber(env.SKILLS_MAX_SKILLS_PER_REPO, 200),
      // 总量上限：12000 以容纳 Claude / OpenCode / Hermes 等多生态聚合（300 仓发现列表）
      maxSkills: readNumber(env.SKILLS_MAX_SKILLS, 12000),
      /*
       * 技能级质量门槛（第三级判定）：仓库通过 Q1-Q3 之后，
       * 逐个检查 SKILL.md 是否值得上站。阈值来自 2026-10 的全量分布分析
       * （6181 条在站技能，见 docs/skill-quality.md）：
       *   - 正文 p25 = 2483 字符；<2000 的 1316 条里集中了符号链接指针、
       *     测试残留（"First skill" 9 字符）、模板文件等
       *   - 无 frontmatter.description 的 298 条会把描述退化成
       *     目录名拼接（"Cmd Cs Aeo"），一律不上站
       *   - 仓内失效占比 >90% 的整仓剔除（实测命中 7 仓，
       *     alirezazvani/claude-skills 186/186 全是符号链接指针）
       * 被拒技能不进清单 → 不产页、不进索引、AI 分类不为它花钱。
       *
       * 开关：
       *   SKILLS_SKILL_GATE=0         关闭全部技能级判定
       *   SKILLS_MIN_BODY_CHARS       正文下限（默认 2000；传 0 关闭该项）
       *   SKILLS_REQUIRE_DESCRIPTION  设 0 允许无描述上站
       *   SKILLS_REPO_JUNK_RATIO      整仓剔除比例（默认 0.9；传 0 关闭该项）
       */
      skillGate:
        env.SKILLS_SKILL_GATE === '0'
          ? undefined
          : {
              minBodyChars: readOptionalNumber(env.SKILLS_MIN_BODY_CHARS, 2000),
              requireDescription: env.SKILLS_REQUIRE_DESCRIPTION !== '0',
              repoJunkRatio: readOptionalRatio(env.SKILLS_REPO_JUNK_RATIO, 0.9),
            },
      /*
       * AI 质量审查（第四级判定）：ai-classify 步骤把 LLM 的 keep/drop
       * 判定写进记忆库（分类 + 质量双输出，一次调用两用），构建时生效。
       * SKILLS_AI_SCREEN=0 一键关闭（影子模式：判定照常记录但不拦截）。
       * 记忆库缺失/条目过旧时自动放行——AI 不可用不影响站点构建。
       */
      aiScreen: env.SKILLS_AI_SCREEN !== '0',
      token: env.GITHUB_TOKEN,
      apiBase: env.GITHUB_API_BASE,
      rawBase: env.GITHUB_RAW_BASE,
    }),
  ),
  schema: z.object({
    title: z.string(),
    titleEn: z.string(),
    description: z.string(),
    descriptionEn: z.string(),
    category: z.enum(categories),
    tags: z.array(z.string()).default([]),
    github: z.url().optional(),
    author: z.string().optional(),
    prompt: z.string().optional(),
    bestFor: z.string().optional(),
    steps: z.array(z.string()).optional(),
    example: z.string().optional(),
    evaluation: z.string().optional(),
    guide: z.string().optional(),
    grade: z.enum(['S', 'A', 'B']).optional(),
    score: z.number().optional(),
    likes: z.number().optional(),
    ratingUp: z.number().optional(),
    /** 来源仓库 star 数（自动发现阶段已获取，零额外请求） */
    stars: z.number().optional(),
    files: z.array(z.string()).optional(),
    added: z.string().optional(),
  }),
})

export const collections = { skills }
