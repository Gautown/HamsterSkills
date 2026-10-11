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
      },
      perRepoMaxSkills: readNumber(env.SKILLS_MAX_SKILLS_PER_REPO, 200),
      // 总量上限：12000 以容纳 Claude / OpenCode / Hermes 等多生态聚合（300 仓发现列表）
      maxSkills: readNumber(env.SKILLS_MAX_SKILLS, 12000),
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
    files: z.array(z.string()).optional(),
    added: z.string().optional(),
  }),
})

export const collections = { skills }
