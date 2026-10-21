/**
 * 页头与站点导航用到的路径推导。
 *
 * 单独抽出来是为了能测：这组值是在构建期写进 HTML 的，
 * 一旦拼错，页面上表现为「搜索跳到别的站」这类很难定位的问题，
 * 而单元测试能在构建前就拦住。
 */
import type { Locale } from '../i18n/translations'

/** 五个语言的路由前缀：简中挂根，其余各占一个路径段 */
export const BASES: Record<Locale, string> = {
  zh: '',
  'zh-tw': '/zh-tw',
  en: '/en',
  ko: '/ko',
  ms: '/ms',
}

/** 语言前缀。zh（默认语言）挂在根路径，前缀为空串 */
export const baseOf = (lang: Locale): string => BASES[lang]

/**
 * 首页地址。品牌链接与「已在首页就地筛选」的判据都用它。
 * 中文站为空串，调用方需要用 `/` 展示，所以这里给 `/`。
 */
export const homePathOf = (lang: Locale): string => baseOf(lang) || '/'

/**
 * 搜索结果页地址。
 *
 * 必须从 `baseOf` 拼，不能从 `homePathOf` 拼：
 * 中文站的 homePath 是 `/`，`${homePath}/search/` 会得到
 * `//search/` —— 那是协议相对 URL，生产环境解析成 `https://search/`
 * （另一个站），本地预览则整个跳错。这个 bug 真的发生过。
 */
export const searchPathOf = (lang: Locale): string => `${baseOf(lang)}/search/`

/** 五种语言对应的搜索页，供测试断言对称性 */
export const SEARCH_PATHS: Record<Locale, string> = {
  zh: searchPathOf('zh'),
  'zh-tw': searchPathOf('zh-tw'),
  en: searchPathOf('en'),
  ko: searchPathOf('ko'),
  ms: searchPathOf('ms'),
}
