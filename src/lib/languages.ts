/**
 * 站点语言注册表。
 *
 * 这里是「语言清单」的唯一出处：路由前缀、hreflang 代码、
 * html lang、og:locale 全部从它派生。
 * 新增语言时改这一个文件（加 translations 词条、标签页目录、
 * wrangler 配置是另外几步，列表见 docs/ 里的部署说明）。
 */
import type { Locale } from '../i18n/translations'

export interface LangMeta {
  /** 路由前缀：zh 挂根（空串），其余带开头的斜杠 */
  base: string
  /** <html lang> 与 hreflang 用 */
  htmlLang: string
  /** og:locale 用（下划线格式） */
  ogLocale: string
  /** 语言菜单里展示的自称（该语言自己的写法） */
  label: string
}

export const LANG_META: Record<Locale, LangMeta> = {
  zh: { base: '', htmlLang: 'zh-CN', ogLocale: 'zh_CN', label: '简体中文' },
  'zh-tw': { base: '/zh-tw', htmlLang: 'zh-TW', ogLocale: 'zh_TW', label: '繁體中文' },
  en: { base: '/en', htmlLang: 'en', ogLocale: 'en_US', label: 'English' },
  ko: { base: '/ko', htmlLang: 'ko', ogLocale: 'ko_KR', label: '한국어' },
  ms: { base: '/ms', htmlLang: 'ms', ogLocale: 'ms_MY', label: 'Bahasa Melayu' },
}

export const LOCALES = Object.keys(LANG_META) as Locale[]

/** 动态路由 src/pages/[lang]/ 用：除默认语言外的全部语言 */
export const NON_DEFAULT_LOCALES = LOCALES.filter((l) => l !== 'zh')

/**
 * 从动态路由参数还原语言。
 * 构建时 getStaticPaths 只产出合法值，这里校验兜底：
 * 万一参数缺失/拼错（如手写 URL 碰到 dev 预览），按默认语言渲染而不是崩溃。
 */
export function localeFromParams(lang: string | undefined): Locale {
  return LOCALES.includes(lang as Locale) ? (lang as Locale) : 'zh'
}

/**
 * 该语言的技能卡片/详情使用哪套正文数据。
 *
 * zh 读中文数据，其余四个语言读英文数据（GitHub 技能多为英文；
 * 韩文/马来文不重译技能正文，仅在界面层本地化）。
 */
export const usesZhContent = (locale: Locale): boolean => locale === 'zh' || locale === 'zh-tw'

/**
 * 抹掉当前语言前缀的站内路径（如 /en/skills/x → /skills/x），
 * 供语言菜单与 hreflang 为同一页面拼出其它语言版本。
 */
export function stripBase(pathname: string, locale: Locale): string {
  const base = LANG_META[locale].base
  if (!base) return pathname || '/'
  if (pathname === base) return '/'
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length)
  return pathname || '/'
}
