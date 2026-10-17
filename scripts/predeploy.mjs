#!/usr/bin/env node
/**
 * 部署前置检查：拦住「用本地残缺构建覆盖线上正式构建」。
 *
 * 背景（真实踩过的坑）：
 *   wrangler deploy 上传的是磁盘上的 dist-zh/。
 *   本地构建没有 GITHUB_TOKEN 时会被 GitHub 限流，
 *   语料只拿到一部分（实测 rateLimited 构建出 4655 条，
 *   而 CI 正式构建是 6576 条），构建全程绿灯、无任何报错。
 *   直接 deploy 就把线上正式版换成了残缺版 —— 少了两千多个 skill，
 *   而且从页面上看只是"好像少了一些"，不容易立刻发现。
 *
 * 所以这里做两件事：
 *   1. 清单标记 rateLimited -> 直接拒绝部署
 *   2. 清单太旧 -> 拒绝（本地缓存不会随 CI 更新，太旧的语料同样不该上线）
 *
 * 通过时打印实际条数，让部署者在推之前就知道将要上线什么。
 *
 * 退出码：0 可部署 / 1 拒绝
 */
import fs from 'node:fs'
import path from 'node:path'

const MANIFEST = path.join('.cache', 'skills-remote', '_manifest.json')
/** 清单超过这个时长就认为已过期（毫秒，默认 6 小时） */
const MAX_AGE_MS = Number(process.env.DEPLOY_MAX_AGE_MS || 6 * 60 * 60 * 1000)

function fail(msg) {
  console.error(`\n  [predeploy] 拒绝部署：${msg}\n`)
  console.error('  正确做法：让 GitHub Actions 构建并部署（推送 main 即会自动触发），')
  console.error('            或本地配置 GITHUB_TOKEN 后重新 npm run build。\n')
  process.exit(1)
}

if (!fs.existsSync(MANIFEST)) {
  fail(`找不到 ${MANIFEST}，本地从未成功构建过。`)
}

let manifest
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
} catch (e) {
  fail(`清单无法解析：${e.message}`)
}

const count = Array.isArray(manifest.skills) ? manifest.skills.length : 0
if (count === 0) fail('清单里 0 条 skill，构建显然没成功。')

if (manifest.rateLimited) {
  fail(
    `本次构建被 GitHub 限流，只收了 ${count} 条 skill。\n` +
      '            限流构建是残缺语料，推上去会顶掉线上的完整版本。',
  )
}

const builtAt = Date.parse(manifest.builtAt || '')
if (!Number.isFinite(builtAt)) {
  fail(`清单的 builtAt 无法解析：${JSON.stringify(manifest.builtAt)}`)
}

const ageMs = Date.now() - builtAt
if (ageMs > MAX_AGE_MS) {
  const hours = (ageMs / 3600000).toFixed(1)
  fail(
    `语料清单已过期 ${hours} 小时（${manifest.builtAt}）。\n` +
      '            本地缓存不会随 CI 更新，拿旧语料部署会把线上退回旧版本。',
  )
}

console.log(`  [predeploy] OK  ${count} 条 skill，清单构建于 ${manifest.builtAt}`)