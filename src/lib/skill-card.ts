/**
 * 技能卡片的客户端渲染。
 *
 * 从 HomePage.astro 抽出来的：搜索结果页要渲染同样的卡片，
 * 复制一份会导致两处样式/字段漂移（历史上卡片已经改过好几轮）。
 */
import type { Locale } from '../i18n/translations'
import { usesZhContent } from './languages'

export interface IndexItem {
  id: string
  title: string
  titleEn: string
  desc: string
  descEn: string
  category: string
  tags: string[]
  grade?: string | null
  score?: number | null
  likes?: number | null
  gh?: boolean
  prompt?: boolean
}

export interface CardLabels {
  locale: Locale
  base: string
  catZh: Record<string, string>
  catEn: Record<string, string>
  /** 当前语言的分类名（HomePage / SearchPage 注入）；缺省回退到中英分支 */
  catLoc?: Record<string, string>
  githubLabel: string
  copyPrompt: string
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export const escapeHtml = (value: string): string =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch)

/**
 * 用于子串匹配的检索文本。
 *
 * 中英双语的标题、描述、标签、分类名**全部**拼进来：
 * 搜英文时中文站也要能命中（描述里常混中文），反之亦然。
 * 这是「兜住长尾」那一半；IDF 负责跨语言召回与排序。
 */
export function searchBlob(item: IndexItem, labels: CardLabels): string {
  return [
    item.title,
    item.titleEn,
    item.desc,
    item.descEn,
    item.tags.join(' '),
    labels.catZh[item.category] ?? '',
    labels.catEn[item.category] ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

/*
 * 编号格底色：Stripe 渐变色带（DESIGN.md 的 gradient mesh）的六段停靠色对，
 * 每张卡按 id 稳定分配一段对角渐变。全部为色板内颜色
 * （cream #f5e9d4 / lemon #9b6829 / subdued #b9b9f9 / soft #665efd /
 *  primary #533afd / magenta #f96bee / ruby #ea2261 / ink #0d253d）。
 */
const RANK_WASHES = ['cream', 'sherbet', 'lavender', 'indigo', 'ruby', 'flare'] as const

/**
 * 按技能 id 稳定取段（djb2 滚动哈希）。
 *
 * 不用真随机：卡片在客户端渲染后会被排序/过滤反复重排（applySort 会重
 * 写编号文本），若每次刷新/重排都换色，同一张卡的颜色会来回跳变——
 * 「随机」的观感应来自卡片之间的分布，而不是单张卡的反复无常。
 */
export function rankWash(id: string): string {
  let h = 5381
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0
  return RANK_WASHES[h % RANK_WASHES.length]
}

export function cardHtml(item: IndexItem, rank: number, labels: CardLabels): string {
  const title = usesZhContent(labels.locale) ? item.title : item.titleEn
  const desc = usesZhContent(labels.locale) ? item.desc : item.descEn
  const catNames = labels.catLoc ?? (usesZhContent(labels.locale) ? labels.catZh : labels.catEn)
  const pills = [
    item.grade ? `<span class="grade-mini g-${escapeHtml(item.grade)}">${escapeHtml(item.grade)}</span>` : '',
    item.score != null ? `<span class="score-mini">${escapeHtml(String(item.score))}</span>` : '',
    item.gh ? `<span class="pill pill-gh">${escapeHtml(labels.githubLabel)}</span>` : '',
    item.prompt ? `<span class="pill">${escapeHtml(labels.copyPrompt)}</span>` : '',
  ].join('')
  const tags = item.tags.length
    ? `<div class="tags">${item.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`
    : ''
  const foot = item.tags.length > 1 ? item.tags.slice(1, 3).join(' · ') : ''
  return (
    `<li class="card" data-category="${escapeHtml(item.category)}"` +
    ` data-search="${escapeHtml(searchBlob(item, labels))}"` +
    ` data-score="${Number(item.score) || 0}" data-likes="${Number(item.likes) || 0}">` +
    `<a class="card-link" href="${labels.base}/skills/${escapeHtml(item.id)}">` +
    `<div class="card-head"><div class="card-rank rw-${rankWash(item.id)}">${String(rank).padStart(2, '0')}</div>` +
    `<div class="card-head-main">${pills}</div></div>` +
    `<div class="card-body"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(desc)}</p>${tags}</div>` +
    `<div class="card-foot"><span class="foot-cat">${escapeHtml(catNames[item.category] ?? item.category)}</span>` +
    `<span class="foot-cat">${escapeHtml(foot)}</span></div>` +
    `</a></li>`
  )
}