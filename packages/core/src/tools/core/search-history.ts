import { z } from "zod"
import { make } from "../../shared/tool"
import { getDbAsync } from "../../system/database"

export const searchHistoryTool = make({
  name: "search_history",
  description: "Search past conversation history across sessions. Use when you need to recall what was discussed earlier, revisit past decisions, or find information from previous conversations that might not be in current context.",
  inputSchema: z.object({
    query: z.string().describe("Search keywords or phrase to find in conversation history"),
    sessionId: z.string().optional().describe("Limit search to a specific session ID"),
    limit: z.number().optional().describe("Maximum results to return (default: 5, max: 20)"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, _ctx) {
    const maxResults = Math.min(input.limit || 5, 20)
    const q = `%${input.query}%`

    try {
      const db = await getDbAsync()

      let sql: string
      let params: any[]

      if (input.sessionId) {
        sql = `SELECT m.id, m.session_id, m.role, m.content, m.timestamp, s.title as session_title
               FROM messages m
               JOIN sessions s ON m.session_id = s.session_id
               WHERE m.session_id = ? AND m.content LIKE ?
               ORDER BY m.id DESC
               LIMIT ?`
        params = [input.sessionId, q, maxResults]
      } else {
        sql = `SELECT m.id, m.session_id, m.role, m.content, m.timestamp, s.title as session_title
               FROM messages m
               JOIN sessions s ON m.session_id = s.session_id
               WHERE m.content LIKE ?
               ORDER BY m.id DESC
               LIMIT ?`
        params = [q, maxResults]
      }

      const result = db.exec(sql, params)
      if (result.length === 0 || result[0].values.length === 0) {
        return { success: true, output: `No matching conversations found for "${input.query}".\n💡 升级路径：1) 换更稀有的关键词；2) 用 grep 在当前工作区搜索代码/文件内容；3) 用 memory_search 查找项目记忆。` }
      }

      const rows = result[0].values
      const grouped = new Map<string, Array<{ role: string; content: string; session: string; msgId: number }>>()

      for (const row of rows) {
        const [msgId, sessionId, role, content, ts, sessionTitle] = row as string[]
        const key = `${sessionId} (${sessionTitle || "untitled"})`
        if (!grouped.has(key)) grouped.set(key, [])
        const entry = grouped.get(key)!
        entry.push({
          msgId: parseInt(msgId),
          role,
          content: content.slice(0, 500),
          session: sessionId,
        })
      }

      const lines: string[] = [`## Search Results for "${input.query}"`, ""]
      for (const [sessionKey, messages] of grouped) {
        lines.push(`### ${sessionKey}`)
        for (const msg of messages) {
          const icon = msg.role === "user" ? "Q" : msg.role === "assistant" ? "A" : "T"
          lines.push(`  [${icon}] ${msg.content.slice(0, 300)}`)
        }
        lines.push("")
      }

      lines.push(`Found ${rows.length} matching messages in ${grouped.size} sessions.`)

      return { success: true, output: lines.join("\n") }
    } catch (err) {
      return { success: false, error: `Error searching history: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})

