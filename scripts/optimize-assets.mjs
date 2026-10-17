/**
 * 生成 hero 背景图的 WebP + PNG 两版。
 *
 * 源图与产物的关系：
 *   源图  assets-src/banner2.png  3840x1120、1.4 MB，不部署
 *   产物  public/hero.webp        1920x560、125 KB  现代浏览器
 *         public/hero.png         1920x560、116 KB  不支持 WebP 时回退
 *
 * 为什么源图不放 public/：
 *   public/ 会被 Astro 复制进 dist、每次部署上传 Cloudflare。
 *   1.4 MB 的原图只在生成时用一次，不该跟着每次部署一起传。
 *
 * 为什么固定缩到 1920 宽：
 *   背景图用 background-size: contain 居中显示，
 *   实际呈现宽度不会超过视口。1920 已覆盖到 2K 屏；
 *   再往上只是放大插值，白白多花字节。
 *
 * 为什么 PNG 回退要用 palette：
 *   同尺寸普通 PNG 是 381 KB，量化成 256 色调色板后只要 116 KB。
 *   这张图是纯装饰（pointer-events:none、z-index:-1，
 *   深色模式还会被压到 60% 不透明度并降亮度），色深差异看不出来。
 *
 * 用法：node scripts/optimize-assets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(ROOT, 'assets-src')
const OUT_DIR = path.join(ROOT, 'public')

/** 源图 -> 产物。宽度固定，见文件头说明。 */
const TARGETS = [
  {
    source: 'banner2.png',
    width: 1920,
    outputs: [
      { name: 'hero.webp', format: 'webp', options: { quality: 82 } },
      { name: 'hero.png', format: 'png', options: { compressionLevel: 9, quality: 82, palette: true } },
    ],
  },
]

const kb = n => `${(n / 1024).toFixed(0)} KB`.padStart(8)

for (const { source, width, outputs } of TARGETS) {
  const src = path.join(SRC_DIR, source)
  if (!fs.existsSync(src)) {
    console.error(`  缺少源图 ${path.relative(ROOT, src)}，跳过`)
    process.exitCode = 1
    continue
  }
  const srcBytes = fs.statSync(src).size
  const srcMeta = await sharp(src).metadata()
  console.log(`  源图 ${source}  ${srcMeta.width}x${srcMeta.height}  ${kb(srcBytes)}`)

  for (const out of outputs) {
    const pipeline = sharp(src).resize({ width })
    const buf =
      out.format === 'webp'
        ? await pipeline.webp(out.options).toBuffer()
        : await pipeline.png(out.options).toBuffer()
    fs.writeFileSync(path.join(OUT_DIR, out.name), buf)
    const m = await sharp(buf).metadata()
    console.log(
      `    -> ${out.name.padEnd(11)} ${m.width}x${m.height}  ${kb(buf.length)}` +
        `   省 ${(100 - (buf.length / srcBytes) * 100).toFixed(0)}%`,
    )
  }
}