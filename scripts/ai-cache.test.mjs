/**
 * AI 分类记忆库测试（node:test，零依赖）
 * 运行：node --test scripts/ai-cache.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  aiCacheStats,
  emptyCache,
  loadAiCache,
  lookupAiCategory,
  recordAiCategory,
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

test('写入后可读回', () => {
  const file = tmp()
  const cache = emptyCache()
  recordAiCategory(cache, 'pdf-editor', 'sha-1', 'office', 50)
  saveAiCache(cache, file)

  const loaded = loadAiCache(file)
  assert.equal(lookupAiCategory(loaded, 'pdf-editor', 'sha-1'), 'office')
})

test('sha 变化时视为无缓存（上游改了内容就应重新分类）', () => {
  const cache = emptyCache()
  recordAiCategory(cache, 'pdf-editor', 'sha-1', 'office')
  assert.equal(lookupAiCategory(cache, 'pdf-editor', 'sha-1'), 'office')
  assert.equal(lookupAiCategory(cache, 'pdf-editor', 'sha-2'), undefined)
})

test('不存在的 skill 返回 undefined', () => {
  const cache = emptyCache()
  assert.equal(lookupAiCategory(cache, 'never-seen', 'sha'), undefined)
  assert.equal(lookupAiCategory(undefined, 'x', 'sha'), undefined)
})

test('写入覆盖旧结果', () => {
  const cache = emptyCache()
  recordAiCategory(cache, 'x', 'sha-1', 'dev')
  recordAiCategory(cache, 'x', 'sha-1', 'design')
  assert.equal(lookupAiCategory(cache, 'x', 'sha-1'), 'design')
})

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

test('统计信息正确', () => {
  const cache = emptyCache()
  recordAiCategory(cache, 'a', 's', 'dev', 10)
  recordAiCategory(cache, 'b', 's', 'design', 20)
  const stats = aiCacheStats(cache)
  assert.equal(stats.total, 2)
  assert.equal(stats.tokens, 30)
  assert.deepEqual(stats.distribution, { dev: 1, design: 1 })
  assert.ok(stats.lastAt)
})

test('空库的统计不报错', () => {
  const stats = aiCacheStats(emptyCache())
  assert.equal(stats.total, 0)
  assert.equal(stats.tokens, 0)
})