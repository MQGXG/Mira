import { z } from "zod"
import { make } from "../../shared/tool"
import type { FTSMemoryProvider } from "../../memory/fts-memory-provider"
import { applyRecallBudget, withRecallTimeout } from "../../memory/recall-budget"

/** 召回预算：单条 500 字符，总 4000 字符（防灌爆上下文，参考 Tencent applyRecallBudget） */
const RECALL_BUDGET = { maxCharsPerMemory: 500, maxTotalRecallChars: 4000 }
const RECALL_TIMEOUT_MS = 5000

/**
 * Agent 记忆工具 — Agent 可主动调用 memory_search 和 memory_recall
 * 底层使用 FTSMemoryProvider 的 FTS5 + BM25 全文搜索
 */

/** 模块级单例，由 agent.ts 初始化时注入 */
let ftsProvider: FTSMemoryProvider | null = null

export function setFTSProvider(p: FTSMemoryProvider): void {
  ftsProvider = p
}

function getFTS(): FTSMemoryProvider | null {
  return ftsProvider
}

export const memorySearchTool = make({
  name: "memory_search",
  description: "Search indexed project files and conversation memory using full-text search. Use when you need to find relevant context, code, or past decisions from the current project or previous sessions. Faster and more comprehensive than grep for natural language queries.",
  inputSchema: z.object({
    query: z.string().describe("Search query - natural language keywords or phrases to find in indexed files and memory"),
    type: z.enum(["files", "memory", "all"]).optional().describe("Search scope: 'files' for project files, 'memory' for session memory, 'all' for both (default)"),
    limit: z.number().optional().describe("Maximum results per source (default: 3, max: 10)"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const fts = getFTS()
    if (!fts) {
      return { success: false, error: "FTS memory system not initialized. The system will automatically index files as you work." }
    }

    const limit = Math.min(input.limit || 3, 10)
    const type = input.type || "all"
    const results: string[] = []

    try {
      await withRecallTimeout(async () => {
        if (type === "files" || type === "all") {
          const fileResult = await fts.search(input.query)
          if (fileResult) results.push(fileResult)
        }

        if (type === "memory" || type === "all") {
          const memoryResult = await fts.searchMemory(input.query, limit)
          if (memoryResult) results.push(memoryResult)
        }
      }, RECALL_TIMEOUT_MS)

      // 预算保护：截断/丢弃超限内容
      const budgeted = applyRecallBudget(results, RECALL_BUDGET)

      if (budgeted.length === 0) {
        return {
          success: true,
          output: `No results found for "${input.query}".\n💡 升级路径：1) 换更稀有的关键词重试；2) 用 search_history 搜索历史会话；3) 用 grep 在当前工作区做精确匹配。`,
        }
      }

      return { success: true, output: budgeted.join("\n\n") }
    } catch (err) {
      return {
        success: false,
        error: `Memory search failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})

export const memoryRecallTool = make({
  name: "memory_recall",
  description: "Recall specific information from past conversations and project memory by topic. Use when you need to remember decisions, patterns, or knowledge from earlier in the session or previous sessions.",
  inputSchema: z.object({
    topic: z.string().describe("Topic or subject to recall - e.g., 'project architecture', 'API design decisions', 'bug fixes', 'configuration'"),
    detail: z.enum(["brief", "detailed"]).optional().describe("Level of detail (default: brief)"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const fts = getFTS()
    if (!fts) {
      return { success: false, error: "Memory system not initialized" }
    }

    try {
      const parts: string[] = []

      await withRecallTimeout(async () => {
        const fileResult = await fts.search(input.topic)
        if (fileResult) parts.push(fileResult)

        const memoryResult = await fts.searchMemory(input.topic, input.detail === "detailed" ? 5 : 3)
        if (memoryResult) parts.push(memoryResult)
      }, RECALL_TIMEOUT_MS)

      const budgeted = applyRecallBudget(parts, RECALL_BUDGET)

      if (budgeted.length === 0) {
        return {
          success: true,
          output: `No memories found about "${input.topic}".\n💡 升级路径：1) 用更具体/更稀有的措辞重试；2) 用 search_history 搜索历史会话；3) 用 grep 在当前工作区检索代码或文件。`,
        }
      }

      return { success: true, output: budgeted.join("\n\n") }
    } catch (err) {
      return {
        success: false,
        error: `Memory recall failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})

