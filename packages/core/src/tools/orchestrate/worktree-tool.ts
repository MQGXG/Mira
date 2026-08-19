/**
 * Worktree 工具 — Git 工作树隔离
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { createWorktree, runInWorktree, closeoutWorktree, listWorktrees } from "../../background/worktree"

export const worktreeTool = make({
  name: "worktree",
  description: "为任务创建隔离的工作目录（支持 Git worktree），在隔离目录中执行命令，任务完成后清理",
  inputSchema: z.object({
    action: z.enum(["create", "run", "closeout", "list"]).describe("操作类型"),
    task_id: z.string().optional().describe("任务 ID（create 时必需）"),
    project_path: z.string().optional().describe("项目路径（create 时必需）"),
    command: z.string().optional().describe("要在隔离目录中执行的命令（run 时必需）"),
    worktree_id: z.string().optional().describe("worktree ID（run/closeout 时必需）"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    try {
      if (input.action === "create") {
        if (!input.task_id || !input.project_path) {
          return { success: false, error: "create 需要 task_id 和 project_path" }
        }
        const wt = createWorktree(input.task_id, input.project_path)
        return {
          success: true,
          output: `✅ 已创建隔离工作目录\n\nID: ${wt.id}\n路径: ${wt.path}\n分支: ${wt.branch}\n类型: ${wt.isGitWorktree ? "Git Worktree" : "普通目录"}`,
        }
      }

      if (input.action === "run") {
        if (!input.worktree_id || !input.command) {
          return { success: false, error: "run 需要 worktree_id 和 command" }
        }
        const output = runInWorktree(input.worktree_id, input.command)
        return { success: true, output: output || "命令执行完成（无输出）" }
      }

      if (input.action === "closeout") {
        if (!input.worktree_id) return { success: false, error: "closeout 需要 worktree_id" }
        closeoutWorktree(input.worktree_id)
        return { success: true, output: `已清理 worktree: ${input.worktree_id}` }
      }

      if (input.action === "list") {
        const wts = listWorktrees()
        if (wts.length === 0) return { success: true, output: "没有活跃的 worktree" }
        return {
          success: true,
          output: wts.map((w) => `- ${w.id}: ${w.branch} @ ${w.path} [${w.isGitWorktree ? "Git" : "目录"}]`).join("\n"),
        }
      }

      return { success: false, error: `未知操作: ${input.action}` }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})

