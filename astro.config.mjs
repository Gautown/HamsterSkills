import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { loadEnv } from 'vite'

// 站点域名：本地/CI 通过环境变量注入（未设置时回退到占位域名）
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '')
const site = process.env.SITE_URL || env.SITE_URL || 'https://hamster-skills.example.com'

export default defineConfig({
  site,
  integrations: [sitemap()],
  i18n: {
    locales: ['zh', 'en'],
    defaultLocale: 'zh',
    routing: { prefixDefaultLocale: false },
  },
})
