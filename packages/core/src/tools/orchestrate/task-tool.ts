/**
 * 任务规划工具 — 让 Agent 可以分解复杂任务、按 DAG 依赖顺序执行
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { TaskPlanner } from "../../task/planner"

const planners = new Map<string, TaskPlanner>()

export const taskTool = make({
  name: "plan_task",
  description: "将复杂任务分解为多步计划，按依赖顺序逐步执行。支持创建计划、添加步骤、执行、查看状态",
  inputSchema: z.object({
    action: z.enum(["create", "add_step", "execute", "status", "clear"]).describe("操作类型"),
    plan_id: z.string().optional().describe("计划 ID"),
    description: z.string().optional().describe("计划描述（create 时使用）"),
    step_id: z.string().optional().describe("步骤 ID（add_step 时使用）"),
    step_description: z.string().optional().describe("步骤描述"),
    depends_on: z.array(z.string()).optional().describe("依赖的步骤 ID 列表"),
    command: z.string().optional().describe("步骤要执行的命令或代码"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    try {
      if (input.action === "create") {
        const id = input.plan_id || `plan-${Date.now().toString(36)}`
        if (planners.has(id)) {
          return { success: false, error: `计划 "${id}" 已存在` }
        }
        planners.set(id, new TaskPlanner())
        return { success: true, output: `✅ 计划 "${id}" 已创建\n\n添加步骤后用 execute 执行` }
      }

      const planner = input.plan_id ? planners.get(input.plan_id) : null

      if (input.action === "add_step") {
        if (!planner) return { success: false, error: `计划 "${input.plan_id}" 不存在` }
        if (!input.step_id || !input.step_description) {
          return { success: false, error: "add_step 需要 step_id 和 step_description" }
        }

        const stepId = input.step_id
        planner.define({
          id: stepId,
          description: input.step_description,
          dependsOn: input.depends_on || [],
          execute: async () => {
            return `[步骤 ${stepId}] 已执行: ${input.command || input.step_description}`
          },
        })

        const states = planner.getAllStates()
        const summary = states.map((s) => {
          const depText = s.dependsOn.length > 0 ? ` (依赖: ${s.dependsOn.join(", ")})` : ""
          return `  ${s.status === "done" ? "✅" : s.status === "failed" ? "❌" : "⏳"} ${s.id}: ${s.description}${depText}`
        }).join("\n")

        return { success: true, output: `步骤 "${stepId}" 已添加到计划 "${input.plan_id}"\n\n当前步骤:\n${summary}` }
      }

      if (input.action === "execute") {
        if (!planner) return { success: false, error: `计划 "${input.plan_id}" 不存在` }

        const cycle = planner.detectCycle()
        if (cycle.length > 0) {
          return { success: false, error: `计划存在循环依赖: ${cycle.join(" → ")}` }
        }

        const results = await planner.executeAll()
        const lines = results.map((r) =>
          `  ${r.status === "done" ? "✅" : "❌"} ${r.id}: ${r.description} — ${r.status === "done" ? "成功" : r.error}`
        )

        return {
          success: true,
          output: `计划 "${input.plan_id}" 执行进度:\n${lines.join("\n")}\n\n${planner.summary()}`,
        }
      }

      if (input.action === "status") {
        if (!planner) return { success: false, error: `计划 "${input.plan_id}" 不存在` }
        return { success: true, output: planner.summary() }
      }

      if (input.action === "clear") {
        const id = input.plan_id || ""
        if (id) {
          planners.delete(id)
          return { success: true, output: `已清除计划 "${id}"` }
        }
        planners.clear()
        return { success: true, output: "已清除所有计划" }
      }

      return { success: false, error: `未知操作: ${input.action}` }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})

