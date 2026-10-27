import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { loadEnv } from 'vite'

// 站点域名：本地/CI 通过环境变量注入（未设置时回退到占位域名）
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '')
const DEFAULT_SITE = 'https://hamster-skills.example.com'

/**
 * 校验并归一化站点地址。
 *
 * 为什么要在配置阶段就抛错：`site` 一旦不是合法的绝对 URL，
 * Astro 会在编译**每个 .astro 文件**时抛 `Invalid URL` ——
 * 报错位置是 `astro/dist/vite-plugin-astro/compile.js` 里某一行，
 * 完全看不出问题出在环境变量上。
 * 实测代价：一轮 CI 跑满 30 分钟才拿到那句 Invalid URL，
 * 而真正的原因只是 SITE_URL 少写了 `https://`。
 *
 * 在配置加载时就点明原因，把「翻 node_modules 找线索」变成「读一行错误就懂」。
 *
 * 归一化到 origin：`https://a.com/x/` → `https://a.com`，避免路径混进 canonical。
 */
function resolveSite(raw) {
  if (!raw || !String(raw).trim()) return DEFAULT_SITE
  const value = String(raw)
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`协议必须是 http/https，当前是 ${url.protocol}`)
    }
    return url.origin
  } catch {
    /*
     * 只描述「哪里不对」，不回显原值。
     * SITE_URL 虽然是公开域名，但它以 Secret 形式保存 ——
     * 万一有人把令牌粘进了这一格，截断也拦不住泄漏，索性不回显。
     */
    const problems = []
    if (!/^https?:\/\//i.test(value.trim())) problems.push('缺少 http:// 或 https:// 前缀')
    if (/^["']|["']$/.test(value.trim())) problems.push('值里带了引号（复制时把引号一起粘贴进来了）')
    if (/\s/.test(value.replace(/\n$/, ''))) problems.push('值里含空白字符')
    if (problems.length === 0) problems.push('不是合法的绝对 URL')
    throw new Error(
      `[astro.config] SITE_URL 不合法（长度 ${value.length}）：${problems.join('；')}。\n` +
      `  正确写法示例：https://skill.gautown.top\n` +
      `  GitHub Actions 里改：Settings → Secrets and variables → Actions → SITE_URL`,
    )
  }
}

const site = resolveSite(process.env.SITE_URL || env.SITE_URL)

export default defineConfig({
  site,
  integrations: [
    sitemap({
      // 管理后台不进 sitemap（页面自身也带 noindex + robots 屏蔽）
      filter: (page) => !page.includes('/admin/'),
      // 与 astro.i18n 的路由一一对应：sitemap 会为每条 URL 生成
      // 五语言的 hreflang 互指，与页面 <head> 里的声明保持一致
      i18n: {
        defaultLocale: 'zh',
        locales: {
          zh: 'zh-CN',
          'zh-tw': 'zh-TW',
          en: 'en',
          ko: 'ko',
          ms: 'ms',
        },
      },
    }),
  ],
  i18n: {
    locales: ['zh', 'zh-tw', 'en', 'ko', 'ms'],
    defaultLocale: 'zh',
    routing: { prefixDefaultLocale: false },
  },
})
