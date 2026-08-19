/**
 * Cron 调度工具 — 让 Agent 可以创建和管理定时任务
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { cronScheduler } from "../../background/cron"

export const cronTool = make({
  name: "cronjob",
  description: "创建、列出、删除定时任务。支持标准 cron 表达式(分 时 日 月 周)",
  inputSchema: z.object({
    action: z.enum(["add", "list", "remove"]).describe("操作类型"),
    id: z.string().optional().describe("任务 ID（add/remove 时使用）"),
    expression: z.string().optional().describe("cron 表达式（add 时必需，如 */5 * * * * 表示每5分钟）"),
    description: z.string().optional().describe("任务描述"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    try {
      if (input.action === "list") {
        const tasks = cronScheduler.list()
        if (tasks.length === 0) return { success: true, output: "没有已注册的定时任务" }
        const lines = tasks.map((t) => {
          const next = t.nextRun ? new Date(t.nextRun).toLocaleString("zh-CN") : "无"
          return `- [${t.id}] "${t.description}" ${t.expression} → 下次运行: ${next} ${t.enabled ? "✅" : "⏸️"}`
        })
        return { success: true, output: `定时任务 (${tasks.length}):\n${lines.join("\n")}` }
      }

      if (input.action === "add") {
        if (!input.id || !input.expression) {
          return { success: false, error: "add 需要 id 和 expression 参数" }
        }
        cronScheduler.add(input.id, input.expression, input.description || input.id, async () => {
          // 默认空操作，实际使用时可通过钩子系统注册真实行为
        })
        return { success: true, output: `✅ 定时任务 "${input.id}" 已创建: ${input.expression} — ${input.description || ""}` }
      }

      if (input.action === "remove") {
        if (!input.id) return { success: false, error: "remove 需要 id 参数" }
        cronScheduler.remove(input.id)
        return { success: true, output: `已移除定时任务 "${input.id}"` }
      }

      return { success: false, error: `未知操作: ${input.action}` }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})

