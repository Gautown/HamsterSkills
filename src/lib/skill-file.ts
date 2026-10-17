/**
 * 「哪些文件算 skill」的判定规则。
 *
 * 为什么要从 loader 里抽出来单独成文件：
 *   这个函数是整条流水线的入口闸门 —— 它判 false 的文件，后面
 *   抓取、判定、分类、入库一步都不会发生。
 *
 *   历史事故：Q3 采样窗口写错（只看 README 前 2000 字符），
 *   全站 skill 数从 8769 掉到 2311，构建全程绿灯、没有任何报错。
 *   同类故障的特征都是「静默少东西」，靠人肉看页面发现，
 *   等发现时已经上线了。
 *
 *   纯函数、无 I/O，留在 loader 里就只能靠整站构建来间接验证；
 *   抽出来后可以逐条规则做单元测试。
 *
 * 判定顺序（任一不满足即返回 false）：
 *   1. 文件名（大小写不敏感）必须是 skill.md
 *   2. 必须落在 cfg.path 指定的前缀内（未配置则不限制）
 *   3. 不能落在 cfg.skip 的任一目录/路径下
 */

/** 仓库里用于判定 skill 文件的最小配置面。
 *
 * 刻意只声明实际用到的字段，而不是 import loader 的 RemoteRepo：
 * 那样会形成 双向依赖（loader 引本模块、本模块引 loader 的类型），
 * 而结构化类型让 RemoteRepo 直接兼容，无需 import。
 */
export interface SkillFileRule {
  /** 只扫描该子目录（如 "skills"）；缺省扫描整个仓库 */
  path?: string
  /** 忽略的目录名或相对路径前缀 */
  skip?: string[]
}

/** SKILL.md 的文件名（小写比较用）。 */
export const SKILL_FILENAME = 'skill.md'

/**
 * 判断仓库内某个文件是否是一个 skill 的定义文件。
 *
 * @param filePath 仓库内相对路径
 * @param cfg      仓库配置（只用 path / skip 两个字段）
 */
export function isSkillFile(filePath: string, cfg: SkillFileRule): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const lower = normalized.toLowerCase()
  if (lower !== SKILL_FILENAME && !lower.endsWith(`/${SKILL_FILENAME}`)) return false

  let relative = normalized
  // 前缀两侧的斜杠都要去掉：配置里写 "/skills/" 与 "skills" 应等价
  const prefix = cfg.path?.replace(/^\/+|\/+$/g, '')
  if (prefix) {
    if (!normalized.startsWith(`${prefix}/`)) return false
    relative = normalized.slice(prefix.length + 1)
  }
  return !skipped(relative, cfg.skip)
}

/**
 * 判断相对路径是否落在 skip 名单里。名单支持两种写法：
 *
 *   'templates'  单个目录名 —— 匹配**任意层级**的同名目录段
 *   'a/b'        含斜杠的路径 —— 仍按完整前缀匹配
 *
 * 为什么要按段匹配：
 *   原来是纯前缀匹配，只有位于仓库根部的 templates/ 才挡得住，
 *   嵌在子目录里的漏了进来。用真实缓存量过：
 *   127 个仓库 5527 个 skill 文件中，243 个（4.40%）位于任意层级的
 *   skip 名单目录内，集中在 5 个仓库，样本形如
 *   tools/cc-sdd/templates/agents/antigravity-skills/skills/kiro-debug/SKILL.md
 *   —— 模板副本被当成正式 skill 收了进来。
 *
 *   按段匹配后这 243 条会被剔除，且反向差异为 0（不会因此多收任何文件）。
 *
 * 之所以保留「含斜杠按前缀」这一路：skip 原本的注释就写明支持
 * 「目录名或相对路径前缀」两种写法，a/b 这种用法仍然有效。
 */
export function skipped(relative: string, skip?: string[]): boolean {
  return (skip ?? []).some(entry => {
    if (entry.includes('/')) return relative === entry || relative.startsWith(`${entry}/`)
    return relative.split('/').includes(entry)
  })
}