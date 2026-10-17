/**
 * 生成装饰性图片的 WebP 版本。
 *
 * 为什么需要：
 *   banner.png 是首页 hero 的背景图，每个访客都要下载。
 *   原始 PNG 254 KB，转 WebP 后 43 KB，省 83%。
 *   它是纯装饰（pointer-events:none、z-index:-1，
 *   深色模式还会被压到 60% 不透明度并降亮度），
 *   所以有损压缩的瑕疵在这张图上不可见。
 *
 * 为什么做成脚本而不是直接提交产物：
 *   生成的 banner.webp 是派生文件。留一个脚本说明它怎么来的，
 *   换图后重跑一次即可，不至于出现「webp 和 png 不同源」的漂移。
 *
 * 用法：node scripts/optimize-assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = path.join(ROOT, 'public')

/** 待转换的装饰性图片与 WebP 质量。
 *  数值越高越清晰、体积越大；这些图都不承载文字信息，82 足够。 */
const TARGETS = [{ png: 'banner.png', webp: 'banner.webp', quality: 82 }]

for (const { png, webp, quality } of TARGETS) {
  const src = path.join(PUBLIC, png)
  if (!fs.existsSync(src)) {
    console.log(`  跳过 ${png}（文件不存在）`)
    continue
  }
  const before = fs.statSync(src).size
  const buf = await sharp(src).webp({ quality }).toBuffer()
  const out = path.join(PUBLIC, webp)
  fs.writeFileSync(out, buf)

  const meta = await sharp(src).metadata()
  console.log(
    `  ${png} (${meta.width}x${meta.height})  ${(before / 1024).toFixed(0)} KB` +
      `  ->  ${webp}  ${(buf.length / 1024).toFixed(0)} KB` +
      `  (省 ${(100 - (buf.length / before) * 100).toFixed(0)}%)`,
  )
}