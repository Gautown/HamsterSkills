import { marked, Renderer } from 'marked'

// 远端内容来自公开仓库：转义原始 HTML，避免脚本注入（模块级一次性配置）
const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const renderer = new Renderer()
renderer.html = ({ text }) => escapeHtml(text)
marked.use({ renderer })

/** 渲染 skill Markdown（原始 HTML 转义为纯文本） */
export function renderSkillMarkdown(source?: string): string {
  return source ? (marked.parse(source) as string) : ''
}
