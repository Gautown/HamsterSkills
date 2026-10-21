/**
 * 语言菜单使用的自绘小旗。
 *
 * 为什么不用国旗 emoji：Windows 桌面端（Chrome / Edge，Segoe UI Emoji）
 * 不渲染任何旗号 emoji，只显示 CN / US 这样的两个字母码。
 * 自绘 3:2 的简化 SVG 在所有平台上表现一致，深浅主题下也无需适配。
 */
import type { Locale } from '../i18n/translations'

export const FLAG_SVG: Record<Locale, string> = {
  /* 简中：红底 + 一颗大星示意（四颗小星以圆点弱化） */
  zh:
    '<svg viewBox="0 0 21 14" aria-hidden="true">' +
    '<rect width="21" height="14" fill="#de2910"/>' +
    '<path fill="#ffde00" d="M5 2.4l.6 1.8h1.7L5.9 5.3 6.4 7 5 5.9 3.6 7l.5-1.7L2.7 4.2h1.7z"/>' +
    '<circle cx="9" cy="1.9" r="0.55" fill="#ffde00"/>' +
    '<circle cx="10.2" cy="3.4" r="0.55" fill="#ffde00"/>' +
    '<circle cx="10.2" cy="5.2" r="0.55" fill="#ffde00"/>' +
    '<circle cx="9" cy="6.6" r="0.55" fill="#ffde00"/>' +
    '</svg>',
  /* 繁中（用户选定香港）：红底 + 白色洋紫荆示意（五瓣旋转） */
  'zh-tw':
    '<svg viewBox="0 0 21 14" aria-hidden="true">' +
    '<rect width="21" height="14" fill="#de2910"/>' +
    '<g fill="#fff">' +
    '<ellipse cx="10.5" cy="4.3" rx="1.9" ry="2.8"/>' +
    '<ellipse cx="10.5" cy="4.3" rx="1.9" ry="2.8" transform="rotate(72 10.5 7)"/>' +
    '<ellipse cx="10.5" cy="4.3" rx="1.9" ry="2.8" transform="rotate(144 10.5 7)"/>' +
    '<ellipse cx="10.5" cy="4.3" rx="1.9" ry="2.8" transform="rotate(216 10.5 7)"/>' +
    '<ellipse cx="10.5" cy="4.3" rx="1.9" ry="2.8" transform="rotate(288 10.5 7)"/>' +
    '</g>' +
    '</svg>',
  /* 美国：简化条纹 + 蓝色州牌 */
  en:
    '<svg viewBox="0 0 21 14" aria-hidden="true">' +
    '<rect width="21" height="14" fill="#b22234"/>' +
    '<g fill="#fff">' +
    '<rect y="1.08" width="21" height="1.08"/><rect y="3.23" width="21" height="1.08"/>' +
    '<rect y="5.38" width="21" height="1.08"/><rect y="7.54" width="21" height="1.08"/>' +
    '<rect y="9.69" width="21" height="1.08"/><rect y="11.85" width="21" height="1.08"/>' +
    '</g>' +
    '<rect width="8.6" height="7.54" fill="#3c3b6e"/>' +
    '</svg>',
  /* 韩国：白底 + 太极图（简化）+ 斜角卦线 */
  ko:
    '<svg viewBox="0 0 21 14" aria-hidden="true">' +
    '<rect width="21" height="14" fill="#f5f5f5"/>' +
    '<path d="M6.3 7a4.2 4.2 0 018.4 0z" fill="#cd2e3a"/>' +
    '<path d="M14.7 7a4.2 4.2 0 01-8.4 0z" fill="#0047a0"/>' +
    '<circle cx="8.8" cy="7" r="1.35" fill="#cd2e3a"/>' +
    '<circle cx="12.2" cy="7" r="1.35" fill="#0047a0"/>' +
    '<g stroke="#111" stroke-width="0.55" stroke-linecap="round">' +
    '<path d="M2.4 3.2 4.2 2.2M3 4.5 4.8 3.5M3.6 5.8 5.4 4.8"/>' +
    '<path d="M18.6 3.2 16.8 2.2M18 4.5 16.2 3.5M17.4 5.8 15.6 4.8"/>' +
    '</g>' +
    '</svg>',
  /* 马来西亚：条纹 + 蓝州牌 + 黄色新月与星（简化） */
  ms:
    '<svg viewBox="0 0 21 14" aria-hidden="true">' +
    '<rect width="21" height="14" fill="#cc0001"/>' +
    '<g fill="#fff">' +
    '<rect y="1" width="21" height="1"/><rect y="3" width="21" height="1"/>' +
    '<rect y="5" width="21" height="1"/><rect y="7" width="21" height="1"/>' +
    '<rect y="9" width="21" height="1"/><rect y="11" width="21" height="1"/>' +
    '<rect y="13" width="21" height="1"/>' +
    '</g>' +
    '<rect width="10.5" height="7" fill="#010066"/>' +
    '<circle cx="4.4" cy="3.5" r="2.1" fill="#fc0"/>' +
    '<circle cx="5.2" cy="3.5" r="1.7" fill="#010066"/>' +
    '<path fill="#fc0" d="M7 3.5l.7-.6.3.8.4-.7.6.6-.6.6.8-.2-.2.8-.8-.3.3.8-.8.1-.1-.8-.4.7-.6-.7.8-.3z"/>' +
    '</svg>',
}
