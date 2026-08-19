/**
 * Code Search 工具 — 搜索 API 文档和代码示例
 * 参考 MiMo Code 的 codesearch.ts
 *
 * 用途：当用户问"React useState 怎么用"、"Express middleware"等时
 * Agent 调用此工具搜索相关代码片段和文档
 */

import { z } from "zod"
import { make } from "../../shared/tool"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * 通过 DuckDuckGo 搜索代码相关文档
 * 搜索 site:github.com site:stackoverflow.com 等代码站点
 */
async function searchCodeDocs(query: string, max: number): Promise<SearchResult[]> {
  const codeQuery = `${query} site:github.com OR site:stackoverflow.com OR site:dev.to OR site:docs.python.org`
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(codeQuery)}`

  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return []

    const html = await resp.text()
    const results: SearchResult[] = []

    // 提取搜索结果
    const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
    const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    const snippets: string[] = []

    let m: RegExpExecArray | null
    while ((m = linkRe.exec(html)) !== null && results.length < max) {
      const href = decodeURIComponent(m[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0])
      const title = m[2].replace(/<[^>]+>/g, "").trim()
      if (title && href.startsWith("http")) {
        results.push({ title, url: href, snippet: "" })
      }
    }
    while ((m = snippetRe.exec(html)) !== null) {
      snippets.push(m[1].replace(/<[^>]+>/g, "").trim())
    }
    snippets.forEach((s, i) => {
      if (results[i]) results[i].snippet = s.slice(0, 300)
    })

    return results
  } catch {
    return []
  }
}

/**
 * 获取 URL 的内容摘要
 */
async function fetchSnippet(url: string, maxLen = 2000): Promise<string> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,text/plain,*/*" },
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    })
    if (!resp.ok) return ""

    const contentType = resp.headers.get("content-type") || ""
    const text = await resp.text()

    // 简单 HTML → 文本
    if (contentType.includes("text/html")) {
      return text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen)
    }

    return text.slice(0, maxLen)
  } catch {
    return ""
  }
}

export const codeSearchTool = make({
  name: "code_search",
  description: "Search for code documentation, API references, and programming examples. Use when the user asks about how to use a library, framework, or API.",
  inputSchema: z.object({
    query: z.string().describe("Search query (e.g. 'React useState hook', 'Python pandas filtering', 'Express middleware')"),
    maxResults: z.number().optional().default(5).describe("Max results to return (max 10)"),
    fetchContent: z.boolean().optional().default(true).describe("Fetch page content for top results"),
  }),
  outputSchema: z.string(),
  permission: "web_search",

  async execute(input, _ctx) {
    const max = Math.min(input.maxResults || 5, 10)

    const results = await searchCodeDocs(input.query, max)
    if (results.length === 0) {
      return {
        success: true,
        output: `No code documentation found for: ${input.query}\n\nTry:\n- More specific query\n- Include library/framework name\n- Check spelling`,
      }
    }

    const parts: string[] = [
      `Code search: ${input.query}`,
      `Results: ${results.length}`,
      "─".repeat(40),
    ]

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      parts.push(`\n${i + 1}. ${r.title}`)
      parts.push(`   URL: ${r.url}`)
      if (r.snippet) {
        parts.push(`   ${r.snippet}`)
      }

      // 获取页面内容摘要
      if (input.fetchContent && i < 3) {
        const content = await fetchSnippet(r.url, 1500)
        if (content) {
          parts.push(`\n   Content preview:\n   ${content.slice(0, 1000).split("\n").slice(0, 15).join("\n   ")}`)
        }
      }
    }

    return {
      success: true,
      output: parts.join("\n"),
    }
  },
})

