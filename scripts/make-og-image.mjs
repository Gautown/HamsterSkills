/**
 * 生成社交分享用的 OG 图（og.png）。
 *
 * 为什么必须是 PNG 而不是 SVG：Twitter / Facebook / Slack / LinkedIn 的
 * 图片抓取器**普遍不支持 SVG**（这是各家爬虫的已知限制，与浏览器能否
 * 显示无关）。而 `og:image` 恰恰只会被这些爬虫消费 ——
 * 指向 SVG 等于分享出去永远没有图。
 *
 * 尺寸按 OG 惯例 1200×630（1.91:1），是 Facebook / Twitter 兼容性最好的比例。
 *
 * 零依赖：不引入 sharp/canvas，纯手写 PNG 编码（zlib 走 node 内置）。
 */
import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const W = 1200
const H = 630

/* ---------- 极简 5x7 点阵字体，覆盖本图用到的字符 ---------- */
// 每个字形是 5 列 × 7 行的位图，按行给出，每行 5 bit。
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  // 小写必须补全：漏一个字母会让整行文字出现无意义的空洞
  // （首版漏了 b 和 w，渲染成「amsiter Skils」「li rard」，比没有图更糟）
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  b: ['10000', '10000', '11110', '10001', '10001', '10001', '11110'],
  c: ['00000', '00000', '01110', '10001', '10000', '10001', '01110'],
  d: ['00001', '00001', '01111', '10001', '10001', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01000', '11110', '01000', '01000', '01000', '01000'],
  g: ['00000', '00001', '01111', '10001', '01111', '00001', '01110'],
  h: ['10000', '10000', '11110', '10001', '10001', '10001', '10001'],
  i: ['00100', '00000', '01100', '00100', '00100', '00100', '01110'],
  j: ['00010', '00000', '00110', '00010', '00010', '10010', '01100'],
  k: ['10000', '10000', '10010', '10100', '11000', '10100', '10010'],
  l: ['01100', '00100', '00100', '00100', '00100', '00100', '01110'],
  m: ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  n: ['00000', '00000', '01110', '10001', '10001', '10001', '10001'],
  o: ['00000', '00000', '01110', '10001', '10001', '10001', '01110'],
  p: ['00000', '00001', '01111', '10001', '01111', '00001', '00001'],
  r: ['00000', '00000', '10110', '11001', '10000', '10000', '10000'],
  s: ['00000', '00000', '01111', '10000', '01110', '00001', '11110'],
  t: ['00100', '00100', '11110', '00100', '00100', '00101', '00010'],
  u: ['00000', '00000', '10001', '10001', '10001', '10001', '01110'],
  v: ['00000', '00000', '10001', '10001', '10001', '01010', '00100'],
  // w 首版漏掉，会把 Hamster 里的 w 吃掉
  w: ['00000', '00000', '10001', '10101', '10101', '10101', '01010'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
  y: ['00000', '00001', '00001', '01111', '00001', '10001', '01110'],
  z: ['00000', '00000', '11111', '00010', '00100', '01000', '11111'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '·': ['00000', '00000', '00000', '01100', '00000', '00000', '00000'],
}

/* ---------- 画布 ---------- */
const px = new Uint8Array(W * H * 3)

const set = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  const i = (y * W + x) * 3
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
}

/** 线性渐变填充整幅画布 */
function fillGradient(from, to) {
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1)
    const c = [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ]
    for (let x = 0; x < W; x++) set(x, y, c)
  }
}

function rect(x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, color)
}

/** 用点阵字体绘制字符串；scale 为每个像素的放大倍数 */
function text(str, x0, y0, scale, color) {
  let cx = x0
  for (const ch of str) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== '1') continue
        rect(cx + col * scale, y0 + row * scale, scale, scale, color)
      }
    }
    cx += 6 * scale
  }
  return cx
}

function textWidth(str, scale) {
  return str.length * 6 * scale
}

/* ---------- 绘制 ---------- */
// 与站点 hero 同色系：蓝 → 紫 → 青
fillGradient([14, 36, 66], [12, 62, 84])

// 装饰：右下角柔和光晕，给纯色底一点层次
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - W * 0.78
    const dy = y - H * 0.72
    const d = Math.sqrt(dx * dx + dy * dy)
    const k = Math.max(0, 1 - d / (W * 0.55))
    if (k <= 0) continue
    const i = (y * W + x) * 3
    px[i] = Math.min(255, Math.round(px[i] + 40 * k))
    px[i + 1] = Math.min(255, Math.round(px[i + 1] + 90 * k))
    px[i + 2] = Math.min(255, Math.round(px[i + 2] + 120 * k))
  }
}

const WHITE = [255, 255, 255]
const ACCENT = [122, 205, 255]

// 主标题
const title = 'Hamster Skills'
const tScale = 11
const sub = 'AI skill library · by use case'
const note = 'github.com/Gautown/HamsterSkills'

/*
 * 漏字检查：点阵字体是手写的，漏一个字母只会渲染成空洞（照旧是"成功"退出）。
 * 首版就漏了 b 和 w，输出「amsiter Skils」「li rard」——比没有图更糟，
 * 因为它看起来像一张正常的图。
 */
const used = new Set([...title, ...sub, ...note])
const missing = [...used].filter((ch) => !GLYPHS[ch])
if (missing.length) {
  console.error(`✗ 点阵字体缺少字形：${missing.map((c) => JSON.stringify(c)).join(' ')}`)
  console.error('  请在 GLYPHS 里补上再运行。')
  process.exit(1)
}

/** 检查一行文字是否会超出画布宽度 */
const assertFits = (str, scale, label) => {
  const w = textWidth(str, scale)
  if (w > W - 100) {
    console.error(`✗ ${label} 宽度 ${w}px 超出安全区（画布 ${W}px，右侧需留 100px）`)
    process.exit(1)
  }
  return w
}
assertFits(title, tScale, '主标题')
assertFits(sub, 6, '副标题')
assertFits(note, 5, '底部说明')

text(title, 100, 200, tScale, WHITE)
text(sub, 100, 330, 6, ACCENT)
text(note, 100, 430, 5, [190, 205, 220])

// 左侧竖条装饰
rect(56, 200, 10, 7 * tScale, ACCENT)

/* ---------- PNG 编码 ---------- */
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor RGB
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

// 每行前置 filter byte 0
const raw = Buffer.alloc(H * (1 + W * 3))
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (1 + W * 3) + 1)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const out = path.resolve('public/og.png')
fs.writeFileSync(out, png)
console.log(`已生成 ${out}  ${W}×${H}  ${(png.length / 1024).toFixed(1)} KB`)