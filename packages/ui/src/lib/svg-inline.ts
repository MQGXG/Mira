/**
 * SVG 内嵌渲染 —— 将 markdown 文本中的 ```svg 代码块转换为内嵌 data URL 图片。
 *
 * 为什么用 img 而非直接注入 <svg>：
 * 1. img 上下文（data:image/svg+xml）天然隔离，SVG 内的脚本不会执行，无需手工 sanitize
 * 2. 不接管 streamdown 的代码渲染管线，非 svg 代码块仍走原生 shiki 高亮，零副作用
 * 3. 未完整闭合（流式中途）的代码块保持源码显示，流式安全
 */

const SVG_FENCE_RE = /```(?:svg|svg\+xml)\s*\n([\s\S]*?)```/gi

/** 判断 SVG 文本是否以 </svg> 完整闭合 */
function isCompleteSvg(body: string): boolean {
  return /<\/svg\s*>$/i.test(body.trim())
}

/** UTF-8 安全的 base64 编码 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return btoa(binary)
}

/**
 * 将 markdown 文本中的 ```svg / ```svg+xml 代码块转换为【代码块 + 内嵌渲染图】。
 * 保留原始源码（可查看/复制/高亮），并在其后追加 data URL 图片展示渲染效果。
 * 未完整闭合的代码块（流式生成中）原样保留，避免渲染残缺图。
 */
export function inlineSvgBlocks(text: string): string {
  if (!text) return text

  return text.replace(SVG_FENCE_RE, (whole, body: string) => {
    if (!isCompleteSvg(body)) return whole
    const encoded = toBase64(body.trim())
    return `${whole}\n\n<img class="mira-svg-inline" src="data:image/svg+xml;base64,${encoded}" alt="SVG diagram" />`
  })
}