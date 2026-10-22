/**
 * AI 记忆库测试（node:test，零依赖）
 * 运行：node --test scripts/ai-cache.test.mjs
 *
 * 覆盖分类 + 质量审查双输出：写入/读回、sha 失效、prompt 版本失效、
 * 质量字段的查询与新鲜度（isAiFresh）—— loader 的硬删除与 ai-classify
 * 的回填判定都以这些函数为准，边界错了要么误删内容、要么重复花钱。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AI_PROMPT_VERSION,
  aiCacheStats,
  emptyCache,
  isAiFresh,
  loadAiCache,
  lookupAiCategory,
  lookupAiQuality,
  recordAiResult,
  saveAiCache,
} from '../src/lib/ai-cache.mjs'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-ai-')), 'ai.json')

test('文件不存在时返回空库，不抛错', () => {
  const cache = loadAiCache(path.join(os.tmpdir(), 'definitely-not-exist-9f3a.json'))
  assert.deepEqual(cache, { version: 1, entries: {} })
})

test('文件损坏时返回空库（不让脏数据卡住同步）', () => {
  const file = tmp()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  const cache = loadAiCache(file)
  assert.deepEqual(cache.entries, {})
})

test('结构不对的文件返回空库', () => {
  const file = tmp()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ foo: 'bar' }), 'utf8')
  assert.deepEqual(loadAiCache(file).entries, {})
})

test('写入后可读回（分类 + 质量）', () => {
  const file = tmp()
  const cache = emptyCache()
  recordAiResult(cache, 'pdf-editor', 'sha-1', { category: 'office', quality: 'keep', p: 2 }, 50)
  saveAiCache(cache, file)

  const loaded = loadAiCache(file)
  assert.equal(lookupAiCategory(loaded, 'pdf-editor', 'sha-1'), 'office')
  assert.deepEqual(lookupAiQuality(loaded, 'pdf-editor', 'sha-1', 2), { quality: 'keep', why: '' })
})

test('sha 变化时视为无缓存（上游改了内容就应重新判定）', () => {
  const cache = emptyCache()
  recordAiResult(cache, 'pdf-editor', 'sha-1', { category: 'office', quality: 'keep', p: 2 })
  assert.equal(lookupAiCategory(cache, 'pdf-editor', 'sha-1'), 'office')
  assert.equal(lookupAiCategory(cache, 'pdf-editor', 'sha-2'), undefined)
  assert.equal(lookupAiQuality(cache, 'pdf-editor', 'sha-2', 2), undefined)
})

test('不存在的 skill 返回 undefined', () => {
  const cache = emptyCache()
  assert.equal(lookupAiCategory(cache, 'never-seen', 'sha'), undefined)
  assert.equal(lookupAiCategory(undefined, 'x', 'sha'), undefined)
  assert.equal(lookupAiQuality(cache, 'never-seen', 'sha', 2), undefined)
  assert.equal(lookupAiQuality(undefined, 'x', 'sha', 2), undefined)
})

test('写入覆盖旧结果', () => {
  const cache = emptyCache()
  recordAiResult(cache, 'x', 'sha-1', { category: 'dev', quality: 'keep', p: 2 })
  recordAiResult(cache, 'x', 'sha-1', { category: 'design', quality: 'drop', why: '空壳', p: 2 })
  assert.equal(lookupAiCategory(cache, 'x', 'sha-1'), 'design')
  assert.deepEqual(lookupAiQuality(cache, 'x', 'sha-1', 2), { quality: 'drop', why: '空壳' })
})

/* ------------------------------ 质量判定查询 ------------------------------ */

test('★ 版本不一致时质量判定失效（口径变了旧判定不能用）', () => {
  const cache = emptyCache()
  recordAiResult(cache, 'x', 'sha-1', { category: 'dev', quality: 'drop', why: 'r', p: 2 })
  assert.deepEqual(lookupAiQuality(cache, 'x', 'sha-1', 2), { quality: 'drop', why: 'r' })
  assert.equal(lookupAiQuality(cache, 'x', 'sha-1', 3), undefined)
  // 传 undefined 跳过版本校验（仅测试/特殊场景）
  assert.deepEqual(lookupAiQuality(cache, 'x', 'sha-1', undefined), { quality: 'drop', why: 'r' })
})

test('没有 quality 字段的旧条目 → undefined（自动进入回填而非误用）', () => {
  const cache = emptyCache()
  // 模拟 v1 时代写入的条目：只有分类
  cache.entries['x'] = { sha: 'sha-1', category: 'dev', at: '2026-01-01' }
  assert.equal(lookupAiQuality(cache, 'x', 'sha-1', 2), undefined)
  // 分类查询不受影响（分类不需要版本校验）
  assert.equal(lookupAiCategory(cache, 'x', 'sha-1'), 'dev')
})

test('quality 值非法（拼写错误）→ undefined，不误判为 keep/drop', () => {
  const cache = emptyCache()
  cache.entries['x'] = { sha: 'sha-1', category: 'dev', quality: 'DROP', p: 2 }
  assert.equal(lookupAiQuality(cache, 'x', 'sha-1', 2), undefined)
})

test('drop 理由超长时截断到 160 字符', () => {
  const cache = emptyCache()
  recordAiResult(cache, 'x', 'sha-1', { category: 'dev', quality: 'drop', why: 'x'.repeat(500), p: 2 })
  assert.equal(cache.entries['x'].why.length, 160)
})

/* ------------------------------ isAiFresh ------------------------------ */

test('★ isAiFresh：全部匹配才算新鲜（分类+质量+版本+sha）', () => {
  const cache = emptyCache()
  recordAiResult(cache, 'x', 'sha-1', { category: 'dev', quality: 'keep', p: 2 })
  assert.equal(isAiFresh(cache, 'x', 'sha-1', 2), true)
  // 任一不匹配都要重新处理
  assert.equal(isAiFresh(cache, 'x', 'sha-2', 2), false, 'sha 不一致')
  assert.equal(isAiFresh(cache, 'x', 'sha-1', 3), false, '版本不一致')
  assert.equal(isAiFresh(cache, 'y', 'sha-1', 2), false, '无条目')
  assert.equal(isAiFresh(undefined, 'x', 'sha-1', 2), false, '空库')
})

test('isAiFresh：缺分类或缺质量的条目都要回填', () => {
  const cache = emptyCache()
  cache.entries['noq'] = { sha: 's', category: 'dev', p: 2 }
  cache.entries['nocat'] = { sha: 's', quality: 'keep', p: 2 }
  assert.equal(isAiFresh(cache, 'noq', 's', 2), false)
  assert.equal(isAiFresh(cache, 'nocat', 's', 2), false)
})

test('AI_PROMPT_VERSION 是正整数（bump 协议的前提）', () => {
  assert.ok(Number.isInteger(AI_PROMPT_VERSION) && AI_PROMPT_VERSION >= 1)
})

/* ------------------------------ 其他 ------------------------------ */

test('保存是原子的：不会留下 .tmp 残留', () => {
  const file = tmp()
  saveAiCache(emptyCache(), file)
  const dir = path.dirname(file)
  assert.equal(fs.readdirSync(dir).filter(f => f.includes('.tmp')).length, 0)
  assert.ok(fs.existsSync(file))
})

test('自动创建缺失的父目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-ai-'))
  const file = path.join(base, 'deep', 'nested', 'ai.json')
  saveAiCache(emptyCache(), file)
  assert.ok(fs.existsSync(file))
})

test('统计信息正确（含质量分布）', () => {
  const cache = emptyCache()
  recordAiResult(cache, 'a', 's', { category: 'dev', quality: 'keep', p: 2 }, 10)
  recordAiResult(cache, 'b', 's', { category: 'design', quality: 'drop', why: 'r', p: 2 }, 20)
  cache.entries['c'] = { sha: 's', category: 'dev', at: '2026-01-01' } // 旧条目
  const stats = aiCacheStats(cache)
  assert.equal(stats.total, 3)
  assert.equal(stats.tokens, 30)
  assert.deepEqual(stats.distribution, { dev: 2, design: 1 })
  assert.deepEqual(stats.quality, { keep: 1, drop: 1, unscreened: 1 })
  assert.ok(stats.lastAt)
})

test('空库的统计不报错', () => {
  const stats = aiCacheStats(emptyCache())
  assert.equal(stats.total, 0)
  assert.equal(stats.tokens, 0)
  assert.deepEqual(stats.quality, { keep: 0, drop: 0, unscreened: 0 })
})
