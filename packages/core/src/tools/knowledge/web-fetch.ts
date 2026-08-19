/**
 * Web Fetch 工具 — 网页内容获取
 * 改进：
 * - Turndown 专业 HTML→Markdown 转换（替代手写正则）
 * - SSRF 防护（DNS 级 IP 检查）
 * - TTL 缓存（5 分钟）
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { assertSafeUrl } from "./ssrf-util"
import { TTLCache } from "./cache-util"
import TurndownService from "turndown"
import { filterMainContent } from "./content-filter"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT = 30 * 1000
const MAX_TIMEOUT = 120 * 1000
const FETCH_CACHE_TTL = 5 * 60 * 1000 // 5 分钟

const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const UA_BOT = "MiraCode/1.0"

// Turndown 实例（单例）
let turndown: TurndownService | null = null
function getTurndown(): TurndownService {
  if (!turndown) {
    turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      bulletListMarker: "-",
      hr: "---",
    })
  }
  return turndown
}

// 缓存
const fetchCache = new TTLCache<string>(FETCH_CACHE_TTL)

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  userAgent: string,
): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; body: string; isCloudflare: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    })

    clearTimeout(timer)

    const headers: Record<string, string> = {}
    resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })

    const contentLength = headers["content-length"]
    if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
      return { ok: false, status: 413, statusText: "Response Too Large", headers, body: "", isCloudflare: false }
    }

    const body = await resp.text()
    if (body.length > MAX_RESPONSE_SIZE) {
      return { ok: false, status: 413, statusText: "Response Too Large", headers, body: "", isCloudflare: false }
    }

    const isCloudflare = resp.status === 403 &&
      (headers["cf-mitigated"] === "challenge" || body.includes("cf-browser-verification"))

    return { ok: resp.ok, status: resp.status, statusText: resp.statusText, headers, body, isCloudflare }
  } catch (e: any) {
    clearTimeout(timer)
    if (e.name === "AbortError") {
      return { ok: false, status: 408, statusText: "Request Timeout", headers: {}, body: "", isCloudflare: false }
    }
    throw e
  }
}

export const webFetchTool = make({
  name: "web_fetch",
  description: "Fetch and read content from a specific URL. Returns markdown, text, or HTML. Supports any public HTTP/HTTPS URL. Use when: reading documentation pages, fetching article content, accessing GitHub pages or READMEs, getting API documentation.",
  inputSchema: z.object({
    url: z.string().url().describe("URL to fetch (must start with http:// or https://)"),
    format: z.enum(["markdown", "text", "html"]).optional().default("markdown")
      .describe("Output format: markdown (default), text, or raw html"),
    timeout: z.number().optional().default(30).describe("Timeout in seconds (max 120)"),
    noCache: z.boolean().optional().default(false).describe("Skip cache and fetch fresh content"),
  }),
  outputSchema: z.string(),
  permission: "web_search",

  async execute(input, _ctx) {
    const url = input.url
    const format = input.format || "markdown"
    const timeoutMs = Math.min((input.timeout || 30) * 1000, MAX_TIMEOUT)

    // SSRF 防护
    try {
      await assertSafeUrl(url)
    } catch (e: any) {
      return { success: false, error: e.message }
    }

    // 缓存
    if (!input.noCache) {
      const cacheKey = TTLCache.makeKey("fetch", url, format)
      const cached = fetchCache.get(cacheKey)
      if (cached) {
        return { success: true, output: cached, metadata: { url, format, cached: true } }
      }
    }

    // 第一次尝试：桌面 UA
    let result = await fetchWithTimeout(url, timeoutMs, UA_DESKTOP)

    // Cloudflare 检测 → 用 Bot UA 重试
    if (result.isCloudflare) {
      result = await fetchWithTimeout(url, timeoutMs, UA_BOT)
    }
    // 重定向后 SSRF 检查（最终 URL）
    if (result.ok && result.headers["x-final-url"]) {
      try {
        await assertSafeUrl(result.headers["x-final-url"])
      } catch (e: any) {
        return { success: false, error: `Redirect ${e.message}` }
      }
    }

    if (!result.ok && !result.body) {
      const errorMsg = result.status === 408
        ? `Request timed out after ${input.timeout || 30}s`
        : result.status === 413
          ? "Response too large (exceeds 5MB limit)"
          : `HTTP ${result.status}: ${result.statusText || "Request failed"}`
      return { success: false, error: `${errorMsg}\nURL: ${url}` }
    }

    const contentType = result.headers["content-type"] || ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""

    // 图片处理
    if (mime.startsWith("image/")) {
      const base64 = Buffer.from(result.body, "binary").toString("base64")
      return {
        success: true,
        output: `Image fetched: ${url} (${mime})`,
        metadata: { mime, data: base64, name: url.split("/").pop() || "image" },
      }
    }

    // 内容转换
    let output: string
    const isHTML = mime.includes("html") || mime.includes("xhtml")

    switch (format) {
      case "markdown":
        // 正文噪音过滤（firecrawl 块列表 + crawl4ai Pruning 评分），再转 Markdown
        output = isHTML ? getTurndown().turndown(filterMainContent(result.body)) : result.body
        break
      case "text":
        output = isHTML ? result.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : result.body
        break
      case "html":
        output = result.body
        break
      default:
        output = isHTML ? getTurndown().turndown(filterMainContent(result.body)) : result.body
    }

    // 截断
    const MAX_OUTPUT = 50000
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + `\n\n[Content truncated at ${MAX_OUTPUT} chars]`
    }

    // 写入缓存
    if (!input.noCache) {
      const cacheKey = TTLCache.makeKey("fetch", url, format)
      fetchCache.set(cacheKey, output || "(empty response)")
    }

    return {
      success: true,
      output: output || "(empty response)",
      metadata: { url, contentType: mime, format, size: result.body.length },
    }
  },
})
