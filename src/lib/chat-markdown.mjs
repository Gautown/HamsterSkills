/**
 * 聊天回复的 Markdown 渲染。
 *
 * 助手回复直接进 innerHTML，等于把模型输出变成可执行 HTML。
 * 模型既是不可信输入（用户提问可诱导它输出任意内容），也会照抄检索结果，
 * 所以这里必须当成「外来文本」处理，而不是可信片段。
 *
 * 三条防线，缺一条都能被绕过：
 *   1. 原始 HTML 转义 —— 覆盖 <img onerror>、<svg onload>、<iframe>、<script>；
 *   2. 链接协议白名单 —— 挡住 [x](javascript:)、data:、vbscript:；
 *   3. 图片整体禁用 —— 远端图会把访客 IP 泄露给第三方，且模型本来也不会给出有用的图。
 *
 * 为什么不用「先整体转义再交给 marked」：那样 `&` `<` `>` 都变成实体，
 * 会把 `> 引用` 这类 blockquote 直接打死成普通段落（实测 `&gt; 引用`）。
 * 改写 renderer 才能既保留 Markdown 语法又堵住注入。
 *
 * 无 DOM 依赖，纯字符串进出，便于 node:test 直接覆盖。
 */
import { Marked } from 'marked'

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * 转义 HTML 敏感字符。
 * 引号必须一并转义：代码围栏的语言标注会拼进 class="language-<lang>"，
 * 不转义引号就能从 class 里 breakout（注：实测 marked 自己也会编码，
 * 这里双保险，避免将来换默认值时静默失守）。
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/** 显式放行的协议：其余带协议的地址（javascript: / data: / vbscript: / file:）一律拒绝 */
const ALLOWED_PROTOCOL = /^(?:https?|mailto):/i
/** 无协议的相对路径、锚点、查询串 */
const ALLOWED_BARE = /^[/#?.]/

/**
 * 校验链接目标，危险则返回 null（调用方降级为纯文本）。
 *
 * 先剥控制字符是关键一步：浏览器在解析 URL 时会丢掉 TAB/LF/CR，
 * 所以 `java\nscript:alert(1)` 在真实浏览器里是能执行的。
 * 必须在判定协议前剥掉，剥完再判才能识破这种拆字绕过。
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function sanitizeUrl(raw) {
  const url = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '')
  if (!url) return null
  // 有协议：只认白名单
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return ALLOWED_PROTOCOL.test(url) ? url : null
  // 无协议：站内路径、锚点、协议相对地址
  return ALLOWED_BARE.test(url) ? url : null
}

/** 站内技能路径。id 由 skill-id.mjs 的 slugify 生成，字符集就是 [a-z0-9-] */
const SKILL_PATH = /\/skills\/([a-z0-9][a-z0-9-]*)\//g

/**
 * 把裸技能路径变成可点链接。
 *
 * 入参保证已转义、不含任何尖括号，且 id 字符集受限，
 * 因此替换不会引入标记。站内链接不加 target —— 新标签页打开站内页面是反直觉的。
 */
function linkifySkillPaths(escaped) {
  return escaped.replace(
    SKILL_PATH,
    (match, id) => `<a href="/skills/${id}/">${match}</a>`
  )
}

/**
 * 渲染链接文案时关闭自动链接化。
 * 否则 `[ /skills/a/ ](https://x)` 会产出 <a> 套 <a>，浏览器会把内层标签
 * 拆出外层，造成错位。parseInline 是同步的，计数器足够。
 */
let labelDepth = 0

const renderer = {
  /** 原始 HTML：一律降级成可见文本，绝不成为标签 */
  html(token) {
    return escapeHtml(token.text)
  },

  link(token) {
    labelDepth++
    let label
    try {
      label = this.parser.parseInline(token.tokens ?? [])
    } finally {
      labelDepth--
    }
    const href = sanitizeUrl(token.href)
    // 协议不合法就不给链接，只留文字 —— 用户仍看得懂模型说了什么
    if (!href) return label
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
    return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
  },

  /** 图片整体禁用：只留 alt 文本。远端图会泄露访客 IP 给图床 */
  image(token) {
    return escapeHtml(token.text ?? '')
  },

  text(token) {
    // 带嵌套标记的交给 marked 递归解析，其叶子 text 仍会走到这里
    if (token.tokens) return this.parser.parseInline(token.tokens)
    // marked 用 escaped 标记「原文已是实体」，重复转义会显示成 &amp;
    const raw = token.escaped ? token.text : escapeHtml(token.text)
    return labelDepth > 0 ? raw : linkifySkillPaths(raw)
  },
}

const marked = new Marked({ gfm: true, breaks: true, renderer })

/**
 * 把助手回复的 Markdown 渲染成可安全插入的 HTML。
 *
 * breaks:true —— 模型习惯用单换行分点，不转成 <br> 的话整段会挤成一行。
 *
 * @param {string} text
 * @returns {string}
 */
export function renderChatMarkdown(text) {
  const source = String(text ?? '')
  if (!source) return ''
  return marked.parse(source)
}