/**
 * 追问建议生成 — 基于最后一条助手回复内容动态生成 follow-up 追问
 *
 * 不依赖额外 LLM 调用：通过文本特征（代码块 / 结构 / 主题词）启发式生成
 * 与内容相关的追问，避免写死的通用建议。
 */

/** 技术主题关键词（中英） */
const TOPIC_KEYWORDS = [
  "TypeScript", "React", "Python", "JavaScript", "Node", "SQL", "git", "API",
  "算法", "缓存", "并发", "数据库", "前端", "后端", "架构", "测试", "部署",
  "性能", "安全", "异步", "正则", "组件", "状态管理", "LLM", "prompt", "Docker",
  "CSS", "HTML", "Vite", "Electron", "pnpm", "npm", "WebSocket", "SSE",
]

/** 英文停用词（主题提取时跳过） */
const STOP_WORDS = new Set([
  "the", "and", "you", "for", "are", "this", "with", "that", "your", "from",
  "have", "will", "code", "example", "function", "const", "import", "can",
  "was", "not", "but", "all", "any", "has", "how", "why", "what", "when",
  "where", "which", "while", "using", "into", "than", "then", "there",
])

/** 代码块 / 代码特征检测 */
function hasCode(text: string): boolean {
  return /```|`[A-Za-z][\w-]*`|function\s+\w+|\bconst\s+\w+\s*=|import\s+\w|class\s+\w+|\bexport\b|\breturn\b/.test(text)
}

/** 结构化内容检测（步骤/列表/多段） */
function hasStructure(text: string): boolean {
  return (
    /(^|\n)(\d+[.、)]|[-*•]|步骤|首先|然后|最后|第一|第二|其一|其一)/m.test(text) ||
    text.split("\n").length > 3
  )
}

/** 从文本中提取主题词：优先技术关键词表，其次高频英文标识符 */
function extractTopic(text: string): string | undefined {
  for (const kw of TOPIC_KEYWORDS) {
    if (text.includes(kw)) return kw
  }
  const tokens = text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g)
  if (!tokens) return undefined
  const freq = new Map<string, number>()
  for (const raw of tokens) {
    const w = raw.toLowerCase()
    if (STOP_WORDS.has(w)) continue
    freq.set(w, (freq.get(w) || 0) + 1)
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]
  return top && top[1] >= 2 && top[0].length > 3 ? top[0] : undefined
}

/**
 * 基于助手回复生成 1-3 条追问建议
 * @param text 最后一条助手消息的纯文本内容
 */
export function generateFollowUpSuggestions(text: string): string[] {
  const t = text.trim()
  if (!t) return []

  const suggestions: string[] = []

  // 含代码 → 代码相关追问
  if (hasCode(t)) {
    suggestions.push("解释一下这段代码", "优化这段代码", "这段代码有什么潜在问题")
  }

  // 结构化内容 → 展开 / 总结
  if (hasStructure(t)) {
    suggestions.push("总结一下关键要点", "展开每一步详细说明")
  }

  // 主题深挖
  const topic = extractTopic(t)
  if (topic) {
    suggestions.push(`关于「${topic}」再深入讲讲`)
  }

  // 兜底（无代码、无结构、无主题时）
  if (suggestions.length === 0) {
    suggestions.push("继续说", "举个具体例子", "换个角度解释")
  }

  return [...new Set(suggestions)].slice(0, 3)
}
