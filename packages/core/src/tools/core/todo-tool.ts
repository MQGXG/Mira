/**
 * Todo 工具 — Agent 可以创建、更新、列表、完成任务
 * 与 Goal 系统联动，辅助任务追踪
 */

import type { ToolDef } from "../../shared/tool"
import { getDbAsync, runWrite } from "../../system/database"
import { z } from "zod"

export const todoTool: ToolDef = {
  name: "todo_write",
  description: "Create, update, list, complete, or delete todo items for task tracking. Use this to manage your task list during a session.",
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.any(),
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "list", "complete", "delete"],
        description: "The action to perform",
      },
      id: {
        type: "string",
        description: "Todo ID (required for update/complete/delete)",
      },
      title: {
        type: "string",
        description: "Todo title (required for create)",
      },
      status: {
        type: "string",
        enum: ["pending", "in_progress", "done", "cancelled"],
        description: "Todo status (for update)",
      },
      priority: {
        type: "number",
        description: "Priority: 0=low, 1=medium, 2=high (for create/update)",
      },
    },
    required: ["action"],
  },
  permission: "todo_write",
  execute: async (args: any, ctx: any) => {
    const db = await getDbAsync()
    const { action, id, title, status, priority } = args

    switch (action) {
      case "create": {
        if (!title) return { success: false, error: "title is required for create" }
        const todoId = `todo_${Date.now().toString(36)}`
        runWrite(
          "INSERT INTO todos (id, session_id, title, status, priority) VALUES (?, ?, ?, ?, ?)",
          [todoId, ctx.sessionID, title, "pending", priority || 0],
        )
        return { success: true, output: `Created todo: ${todoId}\nTitle: ${title}\nStatus: pending\nPriority: ${priority || 0}` }
      }

      case "list": {
        const result = db.exec(
          "SELECT id, title, status, priority, created_at FROM todos WHERE session_id = ? ORDER BY priority DESC, created_at ASC",
          [ctx.sessionID],
        )
        if (result.length === 0 || result[0].values.length === 0) {
          return { success: true, output: "No todos found. Create one with action='create'." }
        }
        const todos = result[0].values.map((r: any) => {
          const statusIcon = r[2] === "done" ? "[x]" : r[2] === "in_progress" ? "[>]" : "[ ]"
          return `${statusIcon} ${r[1]} (id: ${r[0]}, priority: ${r[3]})`
        }).join("\n")
        return { success: true, output: `Todos:\n${todos}` }
      }

      case "update": {
        if (!id) return { success: false, error: "id is required for update" }
        const updates: string[] = ["updated_at = datetime('now')"]
        const params: any[] = []
        if (status) { updates.push("status = ?"); params.push(status) }
        if (priority !== undefined) { updates.push("priority = ?"); params.push(priority) }
        if (title) { updates.push("title = ?"); params.push(title) }
        params.push(id, ctx.sessionID)
        runWrite(`UPDATE todos SET ${updates.join(", ")} WHERE id = ? AND session_id = ?`, params)
        return { success: true, output: `Updated todo: ${id}` }
      }

      case "complete": {
        if (!id) return { success: false, error: "id is required for complete" }
        runWrite(
          "UPDATE todos SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND session_id = ?",
          [id, ctx.sessionID],
        )
        return { success: true, output: `Completed todo: ${id}` }
      }

      case "delete": {
        if (!id) return { success: false, error: "id is required for delete" }
        runWrite("DELETE FROM todos WHERE id = ? AND session_id = ?", [id, ctx.sessionID])
        return { success: true, output: `Deleted todo: ${id}` }
      }

      default:
        return { success: false, error: `Unknown action: ${action}. Use create/update/list/complete/delete.` }
    }
  },
}
