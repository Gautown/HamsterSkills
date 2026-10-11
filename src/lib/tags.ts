/**
 * 标签 → URL / 文件路径段。
 * 远端聚合带来的标签是任意字符串，需要防三类问题：
 *  - Windows 非法字符（: " / \ | ? * 等）导致 mkdir 失败
 *  - URL 结构字符（# %）导致链接被截断
 *  - 大小写变体在 Windows（大小写不敏感文件系统）上互相覆盖
 */
const INVALID_CHARS = /[<>:"/\\|?*#%\u0000-\u001f]/g
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/
const MAX_SLUG_LENGTH = 80

export function tagSlug(tag: string): string {
  const slug = tag
    .replace(INVALID_CHARS, '-')
    .replace(/[\s.]+$/, '')
    .trim()
    .toLowerCase()
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  if (!slug) return 'tag'
  return RESERVED_NAMES.test(slug) ? `tag-${slug}` : slug
}

export interface TagPath {
  /** URL / 文件路径段 */
  slug: string
  /** 归入该 slug 的原始标签（第一个用于展示） */
  tags: string[]
}

/** 生成标签页静态路径；同一 slug 的标签合并，避免重复路径或大小写覆盖 */
export function buildTagPaths(entries: Array<{ data: { tags: string[] } }>): TagPath[] {
  const bySlug = new Map<string, string[]>()
  for (const entry of entries) {
    for (const tag of entry.data.tags) {
      const slug = tagSlug(tag)
      const group = bySlug.get(slug)
      if (!group) bySlug.set(slug, [tag])
      else if (!group.includes(tag)) group.push(tag)
    }
  }
  return [...bySlug].map(([slug, tags]) => ({ slug, tags }))
}
