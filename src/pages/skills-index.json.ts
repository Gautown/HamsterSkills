import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'

/**
 * 首页「加载全部技能」按需获取的轻量索引（中英首页共用）。
 * 卡片 HTML 由客户端渲染，避免把全部技能内联进首页（原约 12MB）。
 */
const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max)}…` : text)

export const GET: APIRoute = async () => {
  const skills = await getCollection('skills')
  const items = skills.map(entry => {
    const d = entry.data
    return {
      id: entry.id,
      title: d.title,
      titleEn: d.titleEn,
      desc: clip(d.description),
      descEn: clip(d.descriptionEn),
      category: d.category,
      tags: d.tags,
      grade: d.grade ?? null,
      score: d.score ?? null,
      likes: d.likes ?? null,
      gh: Boolean(d.github),
      prompt: Boolean(d.prompt),
    }
  })
  return new Response(JSON.stringify({ count: items.length, items }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
