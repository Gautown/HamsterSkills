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
const SHARED = ['_astro', 'favicon.svg', 'og.svg', 'robots.txt', '404.html']

if (!fs.existsSync(DIST)) {
  console.error('✗ 未找到 dist/，请先运行 npm run build')
  process.exit(1)
}

fs.rmSync(ZH, { recursive: true, force: true })
fs.rmSync(EN, { recursive: true, force: true })

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