/**
 * 页头与站点导航用到的路径推导。
 *
 * 单独抽出来是为了能测：这组值是在构建期写进 HTML 的，
 * 一旦拼错，页面上表现为「搜索跳到别的站」这类很难定位的问题，
 * 而单元测试能在构建前就拦住。
 */

/** 语言前缀：中文站挂在根，英文站在 /en */
export const baseOf = (lang: 'zh' | 'en'): string => (lang === 'en' ? '/en' : '')

/**
 * 首页地址。品牌链接与「已在首页就地筛选」的判据都用它。
 * 中文站为空串，调用方需要用 `/` 展示，所以这里给 `/`。
 */
export const homePathOf = (lang: 'zh' | 'en'): string => baseOf(lang) || '/'

/**
 * 搜索结果页地址。
 *
 * 必须从 `baseOf` 拼，不能从 `homePathOf` 拼：
 * 中文站的 homePath 是 `/`，`${homePath}/search/` 会得到
 * `//search/` —— 那是协议相对 URL，生产环境解析成 `https://search/`
 * （另一个站），本地预览则整个跳错。这个 bug 真的发生过。
 */
export const searchPathOf = (lang: 'zh' | 'en'): string => `${baseOf(lang)}/search/`

/** 两种语言对应的搜索页，供测试断言对称性 */
export const SEARCH_PATHS: Record<'zh' | 'en', string> = {
  zh: searchPathOf('zh'),
  en: searchPathOf('en'),
}