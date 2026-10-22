/**
 * 安装通道推导：源地址选择、npx skills 命令构建、dl 产物生成。
 *
 * 为什么独立成纯函数模块：
 *   这些字符串会直接写进详情页 HTML —— 用户原样粘进终端执行、
 *   或被官方 CLI 解析。拼错一个字符就是静默的安装失败
 *   （用户只会觉得「命令跑不通」），与 site-paths.ts 的教训同源，
 *   必须能被 scripts/install.test.mjs 逐条钉死。
 *
 * 背景（2026-10 调研，证据见 docs/install-to-agents.md）：
 *   - vercel-labs/skills 的 `npx skills add` 支持「仓库内具体路径」的
 *     tree URL 直接安装单个技能，与本站 github 字段格式完全一致；
 *   - 非交互参数：-y（免确认）、-a <agent>（目标工具）、-g（全局目录）；
 *   - 本地手写技能没有源仓库，由本站 /dl/<id>.md 端点提供符合
 *     Agent Skills 规范的 SKILL.md，CLI 支持直接吃 SKILL.md 下载 URL。
 */

/**
 * Agent Skills 规范的 name 约束（OpenCode 官方文档给出的等价正则）：
 * 小写字母数字，单个连字符分隔，不以 - 开头/结尾，无双连字符。
 */
export const AGENT_SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 规范要求 description 为 1-1024 字符 */
const DESC_MAX = 1024

export interface InstallSourceInput {
  /** mapSkillData 生成的源仓库 tree URL（远端技能必有） */
  github?: string
  /** 技能 id（本地技能的下载通道用它拼 /dl 路径） */
  id: string
  /** 站点 origin（如 https://skill.gautown.top）；本地技能拼绝对 URL 需要 */
  origin?: string
}

/**
 * 选择安装源：
 *   远端技能 → 源仓库 tree URL（装的是上游最新版本，更新随上游走）
 *   本地技能 → 本站 /dl/<id>.md（构建期生成的规范 SKILL.md）
 * 两者都没有（无 github 且无 origin）→ null，调用方隐藏安装入口。
 */
export function installSourceOf(input: InstallSourceInput): string | null {
  if (input.github) return input.github
  if (input.origin && input.id) return `${input.origin.replace(/\/+$/, '')}/dl/${input.id}.md`
  return null
}

export interface InstallCommandOptions {
  source: string
  /** 目标工具的 -a 参数名；缺省 = 不带 -a（CLI 自动识别当前环境） */
  agent?: string
  /** true = 装到用户全局目录（-g）；false = 装到当前项目 */
  global: boolean
}

/** 构建一条可直接粘贴运行的安装命令（-y 免确认，保持末位便于肉眼核对） */
export function buildInstallCommand(options: InstallCommandOptions): string {
  const parts = ['npx', 'skills', 'add', options.source]
  if (options.global) parts.push('-g')
  if (options.agent) parts.push('-a', options.agent)
  parts.push('-y')
  return parts.join(' ')
}

/** YAML 标量：JSON 字符串在 YAML 里是合法的双引号标量，省得手写转义 */
const yamlScalar = (value: string): string => JSON.stringify(value)

export interface AgentSkillMdInput {
  id: string
  /** 英文描述优先（跨工具兼容性最好）；都缺时退回 id（规范要求非空） */
  descriptionEn?: string
  description?: string
  /** SKILL.md 正文（不含 frontmatter） */
  body?: string
  /** 本地技能的提示词，追加到正文末尾（与站内「导出」的组装方式一致） */
  prompt?: string
}

/**
 * 生成符合 Agent Skills 规范的 SKILL.md（/dl 端点的产物）。
 *
 * frontmatter 只保留规范要求的 name/description —— 多余字段在部分
 * 工具下会触发校验警告；站内 richer 的元数据（分类/评分等）留在
 * 详情页展示即可，进 agent 的内容越干净越好。
 */
export function buildAgentSkillMd(input: AgentSkillMdInput): string {
  const name = input.id
  const rawDesc = input.descriptionEn?.trim() || input.description?.trim() || name
  const description = rawDesc.length > DESC_MAX ? `${rawDesc.slice(0, DESC_MAX - 1)}…` : rawDesc
  const body = (input.body ?? '').trim()
  const prompt = (input.prompt ?? '').trim()
  const sections = [body, prompt ? `## Prompt\n\n${prompt}` : ''].filter(Boolean)
  return `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n---\n\n${sections.join('\n\n')}\n`
}
