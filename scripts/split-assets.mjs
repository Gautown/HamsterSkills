import fs from 'node:fs'
import path from 'node:path'

/**
 * 把 dist/ 切成五个 Cloudflare Workers 静态资产目录，绕开免费版「每版本 20,000 个静态资产」的上限：
 *   dist-zh/   → 简中站（dist 根剔除其余语言的目录树）
 *   dist-en/   → 英文站（dist/en/** + 共享资源，使其可独立预览）
 *   dist-zhtw/ → 繁中站（dist/zh-tw/** + 共享资源）
 *   dist-ko/   → 韩文站（dist/ko/** + 共享资源）
 *   dist-ms/   → 马来站（dist/ms/** + 共享资源）
 *
 * 五个 Worker 同域分工（Cloudflare 按最精确路由匹配）：
 *   skill.gautown.top/*        → hamster-skills-zh（根域全部页面）
 *   skill.gautown.top/en/*     → hamster-skills-en
 *   skill.gautown.top/zh-tw/*  → hamster-skills-zhtw
 *   skill.gautown.top/ko/*     → hamster-skills-ko
 *   skill.gautown.top/ms/*     → hamster-skills-ms
 *
 * 全局性请求永远落在根域 zh Worker（同域跨 Worker，各语言站直接复用，零额外配置）：
 *   /api/chat        → zh Worker 的聊天端点（run_worker_first）
 *   /skills-index.json → zh Worker 静态资产（首页「加载全部」与搜索页共用）
 *
 * 用法：npm run split（需先 npm run build）
 */
const root = process.cwd()
const DIST = path.join(root, 'dist')
const LIMIT = Number(process.env.STATIC_ASSET_LIMIT ?? 20000)
/**
 * 各语言站共用的静态资源。
 * - _astro：哈希化的样式/脚本（五站每页都引用）
 * - _headers：Cloudflare 静态资产的响应头规则（安全头 / 缓存策略）
 * - logo.svg / favicon.svg / hero.png：品牌与 hero 背景图，每站直接引用 /
 * - mascot.png：聊天按钮的吉祥物（聊天窗是全局组件，每站每页都渲染）
 * - robots.txt / 404.html：根路径兜底
 */
const SHARED = ['_astro', '_headers', 'favicon.svg', 'logo.svg', 'hero.png', 'mascot.png', 'robots.txt', '404.html']

/** 各语言在 dist/ 中的顶层目录（zh 挂根，不在其中） */
const LOCALE_DIRS = ['en', 'zh-tw', 'ko', 'ms']

/** 输出目录 → 语言树；locale 为 null 的行是简中根站 */
const SITES = [
  { out: 'dist-zh', locale: null },
  { out: 'dist-en', locale: 'en' },
  { out: 'dist-zhtw', locale: 'zh-tw' },
  { out: 'dist-ko', locale: 'ko' },
  { out: 'dist-ms', locale: 'ms' },
]

if (!fs.existsSync(DIST)) {
  console.error('✗ 未找到 dist/，请先运行 npm run build')
  process.exit(1)
}

/*
 * 校验 SHARED 里的文件在 dist/ 根确实存在。
 *
 * 踩过的坑：SHARED 列过一个 `og.svg`，而 public/ 里从来没有这个文件。
 * Astro 不会报错（public/ 下缺文件不阻断构建），
 * copyFileSync 会静默失败（外层有 try/catch），于是：
 *   构建「成功」→ 部署「成功」→ og:image 线上 404 → 社交分享永远没图。
 * 只有在这里显式校验才拦得住。
 */
const missingShared = SHARED.filter((f) => !fs.existsSync(path.join(DIST, f)))
if (missingShared.length) {
  console.error(`✗ SHARED 里的以下资源在 dist/ 中不存在：${missingShared.join(', ')}`)
  console.error('  检查 public/ 下是否真的存在这些文件')
  process.exit(1)
}

/** 递归复制目录；skipTopLevel 用于在复制 dist 根时跳过其它语言的顶层目录 */
function copyTree(src, dest, skipTopLevel = new Set()) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      if (skipTopLevel.has(entry)) continue
      copyTree(path.join(src, entry), path.join(dest, entry))
    }
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

function countFiles(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return total
}

/** 含目录在内的条目数：wrangler 读取时按条目遍历，若平台按条目计数则以此为准 */
function countEntries(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    total += 1
    if (entry.isDirectory()) total += countEntries(path.join(dir, entry.name))
  }
  return total
}

for (const { out, locale } of SITES) {
  const dest = path.join(root, out)
  fs.rmSync(dest, { recursive: true, force: true })
  if (locale) {
    // 语言站：整棵语言目录树（保持 /en/*、/zh-tw/* 等路径不变）+ 共享资源
    copyTree(path.join(DIST, locale), path.join(dest, locale))
    for (const shared of SHARED) {
      copyTree(path.join(DIST, shared), path.join(dest, shared))
    }
    /*
     * 语言版 404：Astro 产物在 /{locale}/404/ 下，提升为站点根的 404.html，
     * 让 not_found_handling: "404-page" 展示本语言的 404 页
     * （否则兜底的是从 dist 根共享来的简中 404）。
     */
    const locale404 = path.join(DIST, locale, '404', 'index.html')
    if (fs.existsSync(locale404)) fs.copyFileSync(locale404, path.join(dest, '404.html'))
  } else {
    // 中文根站：dist 根剔除其余语言目录（语言树由各自 Worker 服务）
    copyTree(DIST, dest, new Set(LOCALE_DIRS))
  }
}

let over = false
const lines = []
for (const { out } of SITES) {
  const dir = path.join(root, out)
  const files = countFiles(dir)
  const entries = countEntries(dir)
  lines.push(`${out}: ${files} 文件 / ${entries} 条目`)
  if (files > LIMIT) {
    console.error(`✗ ${out} 文件数超过 Workers 免费版静态资产上限；可选：升级 Workers Paid（100,000 文件）或精简页面`)
    over = true
  }
  if (entries > LIMIT) {
    console.warn(`⚠ ${out} 条目数（含目录）已超上限：若平台按条目计数会失败，备选：只保留技能数 ≥3 的标签页，或升级 Workers Paid`)
  }
}
console.log(lines.join(' | '))
console.log(`上限 ${LIMIT}`)
if (over) process.exit(2)
console.log('✓ 五站资产切分完成')
