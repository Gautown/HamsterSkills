import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection, type CollectionEntry } from 'astro:content'
import { buildAgentSkillMd } from '../../lib/install'

/**
 * 本地手写技能的安装下载通道（/dl/<id>.md）。
 *
 * 远端技能有源仓库（详情页直接给 tree URL，安装器从上游拉取最新），
 * 本地技能没有源仓库 —— 由这里在构建期生成一份符合 Agent Skills
 * 规范的 SKILL.md，供 skills CLI 直接安装：
 *
 *   npx skills add https://skill.gautown.top/dl/<id>.md -g -a <agent> -y
 *
 * 只有无 github 字段的技能出端点；远端技能不走这里。
 * 路由不带语言前缀（端点不按 locale 复制），五个站点各构建一次。
 */
export const getStaticPaths = (async () => {
  const skills = await getCollection('skills')
  return skills
    .filter(entry => !entry.data.github)
    .map(entry => ({ params: { id: entry.id }, props: { entry } }))
}) satisfies GetStaticPaths

export const GET: APIRoute = ({ props }) => {
  const { entry } = props as { entry: CollectionEntry<'skills'> }
  const md = buildAgentSkillMd({
    id: entry.id,
    descriptionEn: entry.data.descriptionEn,
    description: entry.data.description,
    body: entry.body,
    prompt: entry.data.prompt,
  })
  return new Response(md, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  })
}
