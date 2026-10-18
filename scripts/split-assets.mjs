import fs from 'node:fs'
import path from 'node:path'

/**
 * 把 dist/ 切成两个 Cloudflare Workers 静态资产目录，绕开免费版「每版本 20,000 个静态资产」的上限：
 *   dist-zh/ → 中文站（dist 去掉 en/）
 *   dist-en/ → 英文站（dist/en/** + 共享资源，使其可独立预览）
 * 用法：npm run split（需先 npm run build）
 */
const root = process.cwd()
const DIST = path.join(root, 'dist')
const ZH = path.join(root, 'dist-zh')
const EN = path.join(root, 'dist-en')
const LIMIT = Number(process.env.STATIC_ASSET_LIMIT ?? 20000)
/**
 * 两站共用的静态资源。
 * - _headers：Cloudflare 静态资产的响应头规则（安全头 / 缓存策略）
 * - logo.svg：英文页同样引用 /logo.svg，dist-en 必须自包含
 * - hero.png：hero 背景图（883×124 手工优化资产），英文首页 /en/ 也用同一张
 * - mascot.png：聊天按钮的吉祥物（128px 小版本，源图 assets-src/Mascot.png），
 *   聊天窗是全局组件，两站每页都渲染，dist-en 根目录也要有
 */
const SHARED = [
  '_astro',
  '_headers',
  'favicon.svg',
  'logo.svg',
  'hero.png',
  'mascot.png',
  'robots.txt',
  '404.html',
]

if (!fs.existsSync(DIST)) {
  console.error('✗ 未找到 dist/，请先运行 npm run build')
  process.exit(1)
}

fs.rmSync(ZH, { recursive: true, force: true })
fs.rmSync(EN, { recursive: true, force: true })

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

/** 递归复制目录；skipTopLevel 用于在复制 dist 根时跳过 en/ */
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

// 中文站：dist 去掉 en/
copyTree(DIST, ZH, new Set(['en']))

// 英文站：en/** 保持 /en/* 路径，另复制共享资源以便直接访问英文 Worker 域名
const distEn = path.join(DIST, 'en')
if (fs.existsSync(distEn)) copyTree(distEn, path.join(EN, 'en'))
for (const shared of SHARED) {
  const src = path.join(DIST, shared)
  if (fs.existsSync(src)) copyTree(src, path.join(EN, shared))
}

const zh = countFiles(ZH)
const en = countFiles(EN)
const zhEntries = countEntries(ZH)
const enEntries = countEntries(EN)
console.log(`dist-zh: ${zh} 文件 / ${zhEntries} 条目 | dist-en: ${en} 文件 / ${enEntries} 条目 | 上限 ${LIMIT}`)
if (zh > LIMIT || en > LIMIT) {
  console.error('✗ 文件数超过 Workers 免费版静态资产上限；可选：升级 Workers Paid（100,000 文件）或精简页面')
  process.exit(2)
}
if (zhEntries > LIMIT || enEntries > LIMIT) {
  console.warn('⚠ 条目数（含目录）已超上限：若平台按条目计数会失败，备选：只保留技能数 ≥3 的标签页，或升级 Workers Paid')
}
console.log('✓ 双站资产切分完成')