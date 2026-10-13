/** 单问：触发索引加载并观察助手是否引用站内技能 */
const BASE = 'https://skill.gautown.top'
const q = process.argv[2] || '我想做网页爬虫，有什么技能能用？'

const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: q }] }),
})
console.log('HTTP', res.status)
if (!res.ok) {
  console.log(await res.text())
  process.exit(0)
}
const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = ''
let reply = ''
while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  let nl = buf.indexOf('\n')
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    nl = buf.indexOf('\n')
    if (!line.startsWith('data:')) continue
    const ev = JSON.parse(line.slice(5).trim())
    if (ev.type === 'delta') reply += ev.text
  }
}
console.log('\n回复:\n' + reply)
const ids = [...new Set([...reply.matchAll(/\/skills\/([a-z0-9][a-z0-9-]*)\//g)].map(m => m[1]))]
console.log('\n引用路径:', ids.map(i => `/skills/${i}/`).join(' ') || '(无)')
for (const id of ids) {
  const h = await fetch(`${BASE}/skills/${id}/`, { method: 'HEAD' })
  console.log(`  /skills/${id}/ → ${h.status} ${h.status === 200 ? '✓' : '✗ 编造'}`)
}
