/**
 * 网页正文噪音过滤 — 参考两个项目移植到纯 TS：
 *
 * 1. firecrawl `html.rs`：42 个 EXCLUDE_NON_MAIN_TAGS 选择器（header/footer/nav/广告/侧边栏等），
 *    命中即整棵子树删除，除非内部包含 FORCE_INCLUDE 选择器。
 * 2. crawl4ai `PruningContentFilter`：加权复合评分（text_density 0.4 / link_density 0.2 /
 *    tag_weight 0.2 / class_id_weight 0.1 / text_length 0.1），阈值 0.48，失败则整棵子树删除。
 *
 * 使用 parse5（纯 JS DOM，无原生依赖）解析 HTML。
 */

import { parse, serialize, type DefaultTreeAdapterMap } from "parse5"

type Element = DefaultTreeAdapterMap["element"]
type ParentNode = DefaultTreeAdapterMap["parentNode"]
type ChildNode = DefaultTreeAdapterMap["childNode"]

// ── firecrawl 块列表（EXCLUDE_NON_MAIN_TAGS + FORCE_INCLUDE_MAIN_TAGS）──

const BLOCKLIST_SELECTORS = [
  "header", "footer", "nav", "aside",
  ".header", ".top", ".navbar", "#header",
  ".footer", ".bottom", "#footer",
  ".sidebar", ".side", ".aside", "#sidebar",
  ".modal", ".popup", "#modal", ".overlay",
  ".ad", ".ads", ".advert", "#ad",
  ".lang-selector", ".language", "#language-selector",
  ".social", ".social-media", ".social-links", "#social",
  ".menu", ".navigation", "#nav",
  ".breadcrumbs", "#breadcrumbs",
  ".share", "#share",
  ".widget", "#widget",
  ".cookie", "#cookie",
  ".fc-decoration",
]

const FORCE_INCLUDE_SELECTORS = [
  "#main",
  ".swoogo-cols", ".swoogo-text", ".swoogo-table-div", ".swoogo-space",
  ".swoogo-alert", ".swoogo-sponsors", ".swoogo-title", ".swoogo-tabs",
  ".swoogo-logo", ".swoogo-image", ".swoogo-button", ".swoogo-agenda",
]

// ── crawl4ai PruningContentFilter 配置 ──

const NEGATIVE_PATTERN = /nav|footer|header|sidebar|ads|comment|promo|advert|social|share/i

const METRIC_WEIGHTS = {
  text_density: 0.4,
  link_density: 0.2,
  tag_weight: 0.2,
  class_id_weight: 0.1,
  text_length: 0.1,
} as const

const TAG_WEIGHTS: Record<string, number> = {
  div: 0.5, p: 1.0, article: 1.5, section: 1.0, span: 0.3,
  li: 0.5, ul: 0.5, ol: 0.5,
  h1: 1.2, h2: 1.1, h3: 1.0, h4: 0.9, h5: 0.8, h6: 0.7,
}

const PRUNING_THRESHOLD = 0.48

/** 需要保留标签（避免把代码/表格/关键内容整体删掉） */
const PRESERVE_TAGS = new Set(["pre", "code", "table", "blockquote"])

export interface ContentFilterOptions {
  /** 是否启用正文过滤（默认 true） */
  enabled?: boolean
  /** 评分阈值（默认 0.48，越低越激进） */
  threshold?: number
}

// ── DOM 辅助 ──

function isElement(node: ChildNode | undefined): node is Element {
  return !!node && (node as Element).tagName !== undefined && (node as Element).tagName !== "#text" && (node as Element).tagName !== "#comment"
}

function tagName(node: Element): string {
  return (node.tagName || "").toLowerCase()
}

function getAttr(node: Element, name: string): string {
  const attr = node.attrs?.find((a) => a.name.toLowerCase() === name)
  return attr?.value || ""
}

function elementChildren(node: Element): Element[] {
  return (node.childNodes || []).filter(isElement)
}

function textContent(node: Element): string {
  let out = ""
  for (const child of node.childNodes || []) {
    const text = (child as DefaultTreeAdapterMap["textNode"] | undefined)?.value
    if (text !== undefined) {
      out += text
    } else if (isElement(child)) {
      out += textContent(child)
    }
  }
  return out
}

function innerHtml(node: Element): string {
  const _serialize = serialize as (n: ChildNode) => string
  return (node.childNodes || []).map((c) => _serialize(c)).join("")
}

/** 直接子级 <a> 的文本总长度 */
function linkTextLen(node: Element): number {
  let out = 0
  for (const child of node.childNodes || []) {
    if (isElement(child) && tagName(child) === "a") {
      out += textContent(child).trim().length
    }
  }
  return out
}

/** 是否匹配选择器：tag / .class / #id */
function matchesSelector(node: Element, selector: string): boolean {
  if (selector.startsWith("#")) return getAttr(node, "id") === selector.slice(1)
  if (selector.startsWith(".")) {
    const cls = getAttr(node, "class")
    return cls.split(/\s+/).includes(selector.slice(1))
  }
  return tagName(node) === selector
}

/** parse5 无 removeChild，需手动从父 childNodes 移除并清空 parentNode */
function detach(node: Element): void {
  const parent = node.parentNode
  if (!parent) return
  const idx = parent.childNodes.indexOf(node)
  if (idx >= 0) parent.childNodes.splice(idx, 1)
  node.parentNode = null
}

/** 子树内是否包含任一 force-include 选择器 */
function containsForceInclude(node: Element): boolean {
  if (FORCE_INCLUDE_SELECTORS.some((s) => matchesSelector(node, s))) return true
  return elementChildren(node).some(containsForceInclude)
}

function classIdPenalty(node: Element): number {
  let score = 0
  const cls = getAttr(node, "class")
  if (cls && NEGATIVE_PATTERN.test(cls)) score -= 0.5
  const id = getAttr(node, "id")
  if (id && NEGATIVE_PATTERN.test(id)) score -= 0.5
  return score
}

// ── 主要 API ──

/**
 * 对 HTML 做正文噪音过滤，返回清理后的 HTML 字符串。
 * 若解析失败或过滤后为空，返回原始 HTML（调用方应回退）。
 */
export function filterMainContent(html: string, options: ContentFilterOptions = {}): string {
  if (options.enabled === false || !html) return html
  try {
    const document = parse(html)
    const body = findBody(document)
    if (!body) return html

    removeBlocklist(body)
    pruneTree(body, options.threshold ?? PRUNING_THRESHOLD)

    const serialized = serialize(document)
    // 过滤后正文近乎为空 → 回退原始（避免把动态渲染/无正文页面清光）
    const remainingText = textContent(body).replace(/\s+/g, "").length
    return remainingText >= 20 ? serialized : html
  } catch {
    return html
  }
}

function findBody(document: DefaultTreeAdapterMap["document"]): Element | null {
  const stack: Array<ChildNode | undefined> = [...(document.childNodes || [])]
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    if (isElement(node) && tagName(node) === "body") return node
    if (isElement(node)) stack.push(...(node.childNodes || []))
  }
  return null
}

/** firecrawl 块列表：命中则整棵删除（除非包含 force-include） */
function removeBlocklist(node: Element): void {
  const children = elementChildren(node)
  for (const child of children) {
    const shouldRemove = BLOCKLIST_SELECTORS.some((s) => matchesSelector(child, s))
    if (shouldRemove && !containsForceInclude(child)) {
      detach(child)
    } else {
      removeBlocklist(child)
    }
  }
}

/** crawl4ai 加权评分 + 阈值，失败则整棵子树删除 */
function pruneTree(node: Element, threshold: number): void {
  const children = elementChildren(node)
  for (const child of children) {
    if (PRESERVE_TAGS.has(tagName(child))) continue
    const score = compositeScore(child)
    if (score < threshold) {
      detach(child)
    } else {
      pruneTree(child, threshold)
    }
  }
}

function compositeScore(node: Element): number {
  const textLen = textContent(node).replace(/\s+/g, "").length
  const tagLen = innerHtml(node).length
  const linkLen = linkTextLen(node)
  const tag = tagName(node)

  let score = 0
  let totalWeight = 0

  // text_density 0.4
  const density = tagLen > 0 ? textLen / tagLen : 0
  score += METRIC_WEIGHTS.text_density * density
  totalWeight += METRIC_WEIGHTS.text_density

  // link_density 0.2（链接越多分越低）
  const linkDensity = textLen > 0 ? 1 - linkLen / textLen : 0
  score += METRIC_WEIGHTS.link_density * linkDensity
  totalWeight += METRIC_WEIGHTS.link_density

  // tag_weight 0.2
  score += METRIC_WEIGHTS.tag_weight * (TAG_WEIGHTS[tag] ?? 0.5)
  totalWeight += METRIC_WEIGHTS.tag_weight

  // class_id_weight 0.1
  score += METRIC_WEIGHTS.class_id_weight * Math.max(0, classIdPenalty(node))
  totalWeight += METRIC_WEIGHTS.class_id_weight

  // text_length 0.1（log 缩放）
  score += METRIC_WEIGHTS.text_length * Math.log(textLen + 1)
  totalWeight += METRIC_WEIGHTS.text_length

  return totalWeight > 0 ? score / totalWeight : 0
}
