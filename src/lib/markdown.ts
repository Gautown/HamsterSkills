import { marked, Renderer } from 'marked'

/**
 * skill 正文渲染。
 *
 * 远端内容来自 300 个公开仓库，格式差异极大（实测 8,797 条）：
 *   - 正文长度 27 ~ 990,888 字符
 *   - 4,313 条含表格，其中大量单元格不换行（>300 字符/行）
 *   - 442 条含块级 HTML（div/table/script）
 *   - 270 条正文没有任何标题层级
 * 因此这里做统一的「显示用」规整；原始数据不被修改（导出/安装仍是完整内容）。
 */

/** 需要连同内容一起丢弃的标签：内部是代码或样式，当文本显示只会产生无意义长行 */
const DROP_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg', 'canvas', 'template']

/** 块级标签，去标签时补空格，避免相邻文字粘连 */
const BLOCK_TAGS = ['div', 'p', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'table']

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 从一段原始 HTML 块里提取可读文本。
 * 丢弃标签本身（script/style 等连内容一起丢），保留标签之间的文字。
 */
function htmlToPlainText(raw: string): string {
  const drop = DROP_TAGS.join('|')
  let text = raw
    // 成对出现的丢弃元素，连内部内容一起去掉
    .replace(new RegExp(`<(${drop})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi'), ' ')
    // 未闭合的单个丢弃标签（如 <script src="...">）
    .replace(new RegExp(`<(${drop})\\b[^>]*>`, 'gi'), ' ')
  // 其余标签去标签留文字；块级标签前后补空格
  text = text.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag: string) =>
    BLOCK_TAGS.includes(tag.toLowerCase()) ? ' ' : '',
  )
  // 反转义实体，还原成可读字符
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#3[59];/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

const renderer = new Renderer()
renderer.html = ({ text }) => escapeHtml(htmlToPlainText(String(text ?? '')))
marked.use({ renderer, gfm: true, breaks: false })

/**
 * 给表格包一层横向滚动容器。
 *
 * 用渲染后处理而非改写 renderer.table：marked 各版本的 table renderer 签名不一致，
 * 后处理跨版本稳定。实测有 3,104 条正文含 >300 字符的超长行（多为表格单元格），
 * 不加滚动容器会直接撑破详情页布局。
 */
function wrapTables(html: string): string {
  return html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, '</table></div>')
}

/** 渲染 skill Markdown（原始 HTML 转义为纯文本） */
export function renderSkillMarkdown(source?: string): string {
  return source ? wrapTables(marked.parse(source) as string) : ''
}

/**
 * 正文显示长度上限。
 * 实测 p90 = 16,866 字符，最长一条达 990,888（约 37 万字），整段渲染会拖垮页面。
 * 超出部分截断，由组件展示查看完整内容的指引。
 */
export const BODY_DISPLAY_LIMIT = 60_000

/**
 * 判断正文是否「实质为空」：只有路径引用、占位符或极少文字。
 *
 * 实测存在真实样本：cmd-cs-aeo / changelog / cmd-a11y-audit 的正文分别是
 * "../../../commands/cs-aeo.md" 这类相对路径——直接渲染出来用户只会看到
 * 一个无意义的相对路径，不如明确告知去源码看。
 */
export function isPlaceholderBody(body?: string): boolean {
  const text = (body ?? '').trim()
  if (text.length === 0) return true
  if (text.length > 80) return false
  // 纯相对路径
  if (/^(\.{1,2}\/)+[\w\-./]+$/.test(text)) return true
  // 纯链接
  if (/^https?:\/\/\S+$/.test(text)) return true
  // 占位提示
  if (/^(insert|add|write|your|instructions?|todo|tbd|n\/a|coming soon|placeholder)[\s.…]*$/i.test(text)) return true
  return false
}

/**
 * 渲染正文用于页面显示：超长内容自动截断。
 *
 * 截断后再校验一次渲染结果：HTML 转义会让字符数膨胀（`&` → `&amp;`），
 * 按源文本长度截断并不足以保证输出体积受控，因此若渲染结果仍超限，
 * 再按比例收紧截断点，最多迭代 3 次。
 *
 * @returns html 渲染结果；truncated 是否截断；fullLength 原始长度
 */
export function renderSkillBodyForDisplay(body?: string): {
  html: string
  truncated: boolean
  fullLength: number
} {
  const text = body ?? ''
  const fullLength = text.length

  // 明显超长的文档（实测最长一条 990,888 字符）直接按源长度比例截断，
  // 不做「先完整渲染一次」的探测——否则要为一份必然要丢弃的内容付出全部解析代价。
  // 8,797 条里有 78 条走这条路径，能省掉大部分无谓开销。
  if (fullLength > BODY_DISPLAY_LIMIT * 1.5) {
    return {
      html: renderTruncated(text, Math.floor(BODY_DISPLAY_LIMIT * 1.2)),
      truncated: true,
      fullLength,
    }
  }

  // 剩余条目先完整渲染：体积上限按「渲染结果」判定，而不是源文本长度。
  // 源文 5-6 万字符的条目，渲染后会膨胀 1.2~1.5 倍（表格标签、实体转义），
  // 若只看源长度就会漏掉这一批。
  const fullHtml = renderSkillMarkdown(text)
  if (fullLength <= BODY_DISPLAY_LIMIT && fullHtml.length <= BODY_DISPLAY_LIMIT) {
    return { html: fullHtml, truncated: false, fullLength }
  }

  // 按已测得的膨胀比例一次性估算截断点
  const estimate = Math.floor((BODY_DISPLAY_LIMIT / fullHtml.length) * fullLength) - 1
  return { html: renderTruncated(text, estimate), truncated: true, fullLength }
}

/**
 * 按给定源长度截断渲染，并在段落边界收口。
 * 迭代最多 4 轮：估算可能偏乐观（膨胀比随内容变化），按实际比例收紧。
 */
function renderTruncated(text: string, initialCut: number): string {
  const MIN_CUT = Math.floor(BODY_DISPLAY_LIMIT * 0.2)
  let cut = Math.min(text.length, Math.max(initialCut, MIN_CUT))
  let html = renderSkillMarkdown(text.slice(0, cut))
  for (let attempt = 0; html.length > BODY_DISPLAY_LIMIT && attempt < 4; attempt++) {
    const next = Math.floor(cut * (BODY_DISPLAY_LIMIT / html.length) * 0.95)
    if (next >= cut || next < MIN_CUT) break
    cut = next
    html = renderSkillMarkdown(text.slice(0, cut))
  }
  // 收口到段落边界，避免把表格或代码块劈成两半
  if (cut > MIN_CUT) {
    const boundary = text.lastIndexOf('\n\n', cut)
    if (boundary > MIN_CUT && boundary < cut) {
      html = renderSkillMarkdown(text.slice(0, boundary))
    }
  }
  return html
}