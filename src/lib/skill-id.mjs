/**
 * skill id 推导：loader（TS）与离线脚本（mjs）共用同一份实现。
 *
 * 为什么必须共用：
 *   AI 记忆库以 skill id 为唯一键（见 ai-cache.mjs）。id 一旦在两处出现
 *   细微差异，记忆库就会静默错位——AI 花的钱记到用不上的键上，
 *   站点构建时查不到，只能退回规则层，且没有任何报错。
 *   所以推导逻辑只允许存在这一份。
 *
 * 纯 Node 模块，无第三方依赖。
 */

/**
 * 取文件所在目录（去掉文件名本身）。
 * `a/b/skill.md` → `a/b`；`skill.md` → ``（空串，表示仓库根目录）
 *
 * @param {string} filePath
 * @returns {string}
 */
export function skillDirectory(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/')
  parts.pop()
  return parts.join('/')
}

/**
 * 生成 URL/文件名安全的 slug。
 * 注意：非 ASCII（中文等）会被整体替换掉，因此可能得到空串，
 * 调用方需准备 fallback（见 deriveSkillId）。
 *
 * @param {string} value
 * @returns {string}
 */
export function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Windows 保留设备名（con/aux/nul 等）不能作为目录名
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `${slug}-skill` : slug
}

/**
 * 由 SKILL.md 的仓库内路径推导 skill id。
 *
 * 规则（与站点路由、详情页 URL 一致）：
 *   1. 取文件所在目录的最后一段作为目录名
 *   2. 目录名 slug 化；为空（非 ASCII 等情况）则退回仓库名
 *   3. 仍为空则调用方应跳过该条目
 *
 * @param {string} filePath 仓库内相对路径，如 `skills/pdf/SKILL.md`
 * @param {string} repoName 仓库名（owner/name 的第二段），目录名不可用时兜底
 * @returns {string} 可能为空串，调用方需判断
 */
export function deriveSkillId(filePath, repoName) {
  const dir = skillDirectory(filePath)
  const dirName = dir.split('/').filter(Boolean).pop() ?? repoName
  return slugify(dirName) || slugify(repoName)
}
