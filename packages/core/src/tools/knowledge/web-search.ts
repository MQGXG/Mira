/**
 * Web Search 工具 — 双引擎搜索
 *
 * 路由策略：
 * 1. 有 config.apiKey → Exa / Parallel MCP 协议（付费，高质量）
 * 2. 无 config.apiKey → DuckDuckGo → SEArxNG 降级（免费，质量一般）
 */

import { z } from "zod"
import { make, type ToolContext } from "../../shared/tool"
import { TTLCache } from "./cache-util"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const SEARCH_CACHE_TTL = 2 * 60 * 1000 // 2 分钟

interface SearchResult {
  title: string
  url: string
  content: string
  source: string
}

// ─── MCP 协议搜索（Exa / Parallel）────────────────────

interface MCPToolCall {
  name: string
  arguments: Record<string, unknown>
}

async function callMCP(url: string, apiKey: string, toolCall: MCPToolCall): Promise<string> {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolCall.name, arguments: toolCall.arguments },
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "User-Agent": "MiraCode/1.0",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) throw new Error(`MCP HTTP ${resp.status}: ${await resp.text().catch(() => "")}`)

  const data = (await resp.json()) as {
    error?: { message?: string }
    result?: { content?: Array<{ type?: string; text?: string }> }
  }
  if (data.error) throw new Error(`MCP error: ${data.error.message || JSON.stringify(data.error)}`)

  // 从 MCP 响应中提取结果文本
  const content = data.result?.content || []
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n")
}

/** Exa 搜索 */
async function exaSearch(query: string, max: number, apiKey: string): Promise<string | null> {
  try {
    return await callMCP("https://mcp.exa.ai/mcp", apiKey, {
      name: "web_search_exa",
      arguments: { query, numResults: max, type: "auto" },
    })
  } catch { return null }
}

/** Parallel 搜索 */
async function parallelSearch(query: string, max: number, apiKey: string): Promise<string | null> {
  try {
    return await callMCP("https://search.parallel.ai/mcp", apiKey, {
      name: "web_search",
      arguments: { query, numResults: max },
    })
  } catch { return null }
}

// ─── DuckDuckGo HTML 搜索（免费）────────────────────────

async function ddg(query: string, max: number): Promise<SearchResult[] | null> {
  try {
    const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return null
    const html = await resp.text()

    const results: SearchResult[] = []
    const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    const snippets: string[] = []

    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html)) !== null && results.length < max) {
      const href = decodeURIComponent(m[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0])
      const title = m[2].replace(/<[^>]+>/g, "").trim()
      if (title && href.startsWith("http")) results.push({ title, url: href, content: "", source: "duckduckgo" })
    }
    while ((m = snippetRe.exec(html)) !== null) snippets.push(m[1].replace(/<[^>]+>/g, "").trim())
    snippets.forEach((s, i) => { if (results[i]) results[i].content = s })

    return results.length > 0 ? results : null
  } catch { return null }
}

/** SEArxNG 公共实例 */
async function searxng(query: string, max: number, instance?: string): Promise<SearchResult[] | null> {
  const instances = instance
    ? [instance]
    : ["https://search.sapti.me", "https://searx.be", "https://searx.work"]
  for (const base of instances) {
    try {
      const resp = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) continue
      const data = (await resp.json()) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> }
      const items = (data.results || []).slice(0, max).filter((r) => Boolean(r.title && r.url))
      if (items.length > 0) return items.map((r) => ({
        title: r.title as string, url: r.url as string,
        content: typeof r.content === "string" ? r.content.slice(0, 500) : "",
        source: "searxng",
      }))
    } catch { continue }
  }
  return null
}

/** 格式化搜索结果 */
function formatResults(results: SearchResult[], query: string, source: string): string {
  return [
    `来源: ${source}`,
    `查询: ${query}`,
    `结果: ${results.length}`,
    "─".repeat(40),
    ...results.map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.content.slice(0, 300)}`),
  ].join("\n")
}

// ─── 缓存 ──────────────────────────────────────────────

const searchCache = new TTLCache<string>(SEARCH_CACHE_TTL)

export const webSearchTool = make({
  name: "web_search",
  description: `Search the web for current information (as of ${new Date().getFullYear()}). When API key is configured, uses professional search API (Exa/Parallel); otherwise uses DuckDuckGo with SEArxNG fallback (free). Use when: needing current information, looking for documentation, finding solutions to problems, researching topics. Do NOT use for: questions that can be answered from the conversation or workspace, file content (use grep/read_file instead), or memory (use memory_search).`,
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().default(5).describe("Max results (max 10)"),
    searxInstance: z.string().optional().describe("Custom SEArxNG instance URL (only used when no API key)"),
    noCache: z.boolean().optional().default(false).describe("Skip cache and search fresh"),
  }),
  outputSchema: z.string(),
  permission: "web_search",
  async execute(input, ctx) {
    const max = Math.min(input.maxResults || 5, 10)

    // 缓存
    if (!input.noCache) {
      const cacheKey = TTLCache.makeKey("search", input.query, String(max))
      const cached = searchCache.get(cacheKey)
      if (cached) return { success: true, output: cached, metadata: { query: input.query, cached: true } }
    }

    // 从 context 获取 API Key（provider 配置）
    const mcpApiKey = (ctx as any).apiKey as string | undefined

    // 有 API Key → 走 MCP 搜索
    if (mcpApiKey) {
      const exaResult = await exaSearch(input.query, max, mcpApiKey)
      if (exaResult) {
        if (!input.noCache) searchCache.set(TTLCache.makeKey("search", input.query, String(max)), exaResult)
        return { success: true, output: exaResult, metadata: { query: input.query, source: "exa" } }
      }

      const parallelResult = await parallelSearch(input.query, max, mcpApiKey)
      if (parallelResult) {
        if (!input.noCache) searchCache.set(TTLCache.makeKey("search", input.query, String(max)), parallelResult)
        return { success: true, output: parallelResult, metadata: { query: input.query, source: "parallel" } }
      }
    }

    // 无 API Key 或 MCP 失败 → 免费搜索
    const ddgResults = await ddg(input.query, max)
    if (ddgResults) {
      const output = formatResults(ddgResults, input.query, "DuckDuckGo")
      if (!input.noCache) searchCache.set(TTLCache.makeKey("search", input.query, String(max)), output)
      return { success: true, output, metadata: { query: input.query, source: "duckduckgo" } }
    }

    const sxResults = await searxng(input.query, max, input.searxInstance)
    if (sxResults) {
      const output = formatResults(sxResults, input.query, "SEArxNG")
      if (!input.noCache) searchCache.set(TTLCache.makeKey("search", input.query, String(max)), output)
      return { success: true, output, metadata: { query: input.query, source: "searxng" } }
    }

    return {
      success: false,
      error: [
        "搜索失败：所有搜索引擎均不可用。",
        mcpApiKey ? "  - Exa/Parallel: API 调用失败" : "  - 未配置 API Key，使用免费搜索引擎",
        "  - DuckDuckGo: 被屏蔽或超时",
        "  - SEArxNG: 所有公共实例无响应",
        "",
        "解决方法:",
        "  1. 稍后重试",
        "  2. 配置 API Key 启用专业搜索",
        "  3. 使用 web_browse 直接访问目标网站",
      ].join("\n"),
    }
  },
})
