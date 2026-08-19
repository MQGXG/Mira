/**
 * 中文文本处理工具
 * 包含：分词、同义词、文本相似度
 */

/** 中文标点符号 */
const CHINESE_PUNCTUATION = /[\u3000-\u303F\uFF00-\uFFEF\u2000-\u206F\u2E00-\u2E7F！？。，、；：""''【】（）《》]/g

/** 常用中文停用词 */
const STOP_WORDS = new Set([
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
  "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
  "自己", "这", "他", "她", "它", "们", "那", "些", "什么", "这个", "那个",
  "能", "对", "与", "及", "等", "之", "其", "或", "但", "而", "把", "被", "让",
])

/**
 * 简单中文分词（最大匹配法）
 * 不依赖外部词典，使用前向最大匹配
 */
export function tokenizeChinese(text: string): string[] {
  // 1. 清洗文本
  const cleaned = text
    .replace(CHINESE_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

  if (!cleaned) return []

  const tokens: string[] = []

  // 2. 按空格分割（英文/数字）
  const segments = cleaned.split(" ")

  for (const segment of segments) {
    if (!segment) continue

    // 英文/数字直接作为 token
    if (/^[a-z0-9_\-\.]+$/.test(segment)) {
      tokens.push(segment)
      continue
    }

    // 3. 中文分词（前向最大匹配）
    const chineseTokens = segmentChinese(segment)
    tokens.push(...chineseTokens)
  }

  // 4. 过滤停用词和短词
  return tokens.filter(t => t.length >= 2 && !STOP_WORDS.has(t))
}

/**
 * 前向最大匹配分词
 */
function segmentChinese(text: string): string[] {
  const tokens: string[] = []
  let i = 0

  while (i < text.length) {
    let matched = false

    // 尝试从最长匹配（4字）开始
    for (let len = Math.min(4, text.length - i); len >= 2; len--) {
      const word = text.slice(i, i + len)

      // 如果是纯中文或常见词组
      if (isChineseWord(word) || isCommonWord(word)) {
        tokens.push(word)
        i += len
        matched = true
        break
      }
    }

    // 未匹配则取单个字符
    if (!matched) {
      const char = text[i]
      if (isChinese(char) || /[a-z0-9]/.test(char)) {
        tokens.push(char)
      }
      i++
    }
  }

  return tokens
}

/** 判断是否为中文字符 */
function isChinese(char: string): boolean {
  const code = char.charCodeAt(0)
  return code >= 0x4E00 && code <= 0x9FFF
}

/** 判断是否为中文词（2-4字） */
function isChineseWord(word: string): boolean {
  return word.length >= 2 && /^[\u4e00-\u9fff]+$/.test(word)
}

/** 常见编程/技术词组 */
const COMMON_WORDS = new Set([
  // 编程语言
  "javascript", "typescript", "python", "java", "golang", "rust", "csharp",
  // 框架
  "react", "vue", "angular", "svelte", "nextjs", "nuxt", "electron",
  "express", "fastapi", "django", "spring", "flask",
  // 技术概念
  "api", "rest", "graphql", "websocket", "http", "https", "tcp", "udp",
  "database", "sqlite", "postgresql", "mysql", "mongodb", "redis",
  "docker", "kubernetes", "k8s", "nginx", "webpack", "vite",
  "git", "github", "gitlab", "ci", "cd", "devops",
  "ai", "ml", "llm", "gpt", "openai", "anthropic", "claude",
  "frontend", "backend", "fullstack", "mobile", "desktop",
  // 中文技术词
  "打包", "构建", "部署", "测试", "调试", "优化", "重构",
  "组件", "模块", "服务", "接口", "配置", "依赖",
  "状态管理", "路由", "缓存", "日志", "监控",
])

function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word.toLowerCase())
}

/**
 * 生成 n-gram 特征（用于相似度计算）
 */
export function generateNgrams(text: string, n: number = 2): string[] {
  const tokens = tokenizeChinese(text)
  const ngrams: string[] = []

  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(" "))
  }

  return ngrams
}

/**
 * 计算 Jaccard 相似度（基于 token 集合）
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenizeChinese(a))
  const tokensB = new Set(tokenizeChinese(b))

  if (tokensA.size === 0 && tokensB.size === 0) return 0

  let intersection = 0
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++
  }

  const union = tokensA.size + tokensB.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * 计算编辑距离（Levenshtein）
 */
export function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
      }
    }
  }

  return dp[m][n]
}

/**
 * 模糊匹配相似度（基于编辑距离）
 */
export function fuzzySimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - editDistance(a, b) / maxLen
}
