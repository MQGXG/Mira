/**
 * 委派任务工具 — 让 Agent 可以启动子代理执行独立子任务
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { runDelegate, getDelegationStatus, listActiveDelegations, cleanupDelegations } from "../../orchestrate/delegate"
import { ToolRegistry } from "../../system/registry"
import { readFileTool } from "../core/read-file-effect"
import { writeFileTool } from "../core/write-file"
import { listFilesTool } from "../core/list-files"
import { webSearchTool } from "../knowledge/web-search"
import { grepTool } from "../core/grep"
import { globTool } from "../core/glob"
import { codeExecTool } from "../execution/code-exec"
import { bashTool } from "../execution/bash"
import { editFileTool } from "../core/edit-file"
import { skillsListTool } from "../../skill/skill-tools"
import { skillViewTool } from "../../skill/skill-tools"
import { dataAnalysisTool } from "../knowledge/data-analysis"
import { webBrowseTool } from "../knowledge/web-browse"
import { cronTool } from "../orchestrate/cron-tool"
import { taskTool } from "../orchestrate/task-tool"

// 共享注册表（直接构造避免循环依赖）
const registry = new ToolRegistry()
registry.registerEffectLazy(readFileTool)
registry.register(writeFileTool)
registry.register(listFilesTool)
registry.register(webSearchTool)
registry.register(grepTool)
registry.register(globTool)
registry.register(codeExecTool)
registry.register(bashTool)
registry.register(editFileTool)
registry.register(skillsListTool)
registry.register(skillViewTool)
registry.register(dataAnalysisTool)
registry.register(webBrowseTool)
registry.register(cronTool)
registry.register(taskTool)

export const delegateTaskTool = make({
  name: "delegate_task",
  description: "将子任务委派给独立运行的子 Agent。子 Agent 拥有独立的会话、权限子集和步数预算，执行完成后返回结果",
  inputSchema: z.object({
    action: z.enum(["run", "status", "list", "cleanup"]).describe("操作类型"),
    task_id: z.string().optional().describe("任务 ID（不提供则自动生成）"),
    description: z.string().optional().describe("要委派的任务描述（run 时必需）"),
    model: z.string().optional().describe("子 Agent 使用的模型（默认继承父 Agent）"),
  }),
  outputSchema: z.string(),
  execute: async (input, ctx) => {
    try {
      if (input.action === "run") {
        if (!input.description) return { success: false, error: "run 需要 description 参数" }

        const id = input.task_id || `sub-${Date.now().toString(36)}`

        // 从 ctx 继承父 Agent 配置（凭据由 buildToolContext 透传），避免硬编码空 key/默认模型
        const config = {
          sessionID: `${ctx.sessionID}-${id}`,
          workspace: ctx.workspace,
          model: input.model || ctx.model || "gpt-4o-mini",
          apiKey: ctx.apiKey || "",
          apiUrl: ctx.apiUrl || "",
          provider: ctx.provider || "openai",
          headers: ctx.headers,
          options: ctx.options,
          maxSteps: 5,
        }

        // 异步启动子代理，不阻塞父 Agent
        runDelegate(id, ctx.sessionID, input.description, config, registry).catch(() => {})

        return {
          success: true,
          output: `✅ 已启动子任务 "${id}"（后台执行）\n\n任务: ${input.description}\n\n用 delegate_task action=status task_id=${id} 查看进度`,
        }
      }

      if (input.action === "status") {
        if (input.task_id) {
          const task = getDelegationStatus(input.task_id)
          if (!task) return { success: false, error: `任务 "${input.task_id}" 不存在或已清理` }
          const duration = task.completedAt ? `${((task.completedAt - task.startedAt) / 1000).toFixed(1)}s` : "进行中"
          return {
            success: true,
            output: [
              `任务: ${input.task_id}`,
              `状态: ${task.status === "done" ? "✅ 完成" : task.status === "failed" ? "❌ 失败" : "⏳ 执行中"}`,
              `耗时: ${duration}`,
              ``,
              task.result ? `结果:\n${task.result.slice(0, 2000)}` : "（等待执行结果...）",
            ].join("\n"),
          }
        }

        // 列出所有活跃任务
        const active = listActiveDelegations()
        if (active.length === 0) return { success: true, output: "没有活跃的子任务" }
        return {
          success: true,
          output: active.map((t) => `- ${t.id}: ${t.task.slice(0, 80)} [${t.status}]`).join("\n"),
        }
      }

      if (input.action === "list") {
        const { cleanupDelegations: cleanup } = await import("../../orchestrate/delegate")
        cleanup()
        return { success: true, output: "已清理超过 5 分钟的已完成任务" }
      }

      if (input.action === "cleanup") {
        cleanupDelegations()
        return { success: true, output: "已清理过期任务" }
      }

      return { success: false, error: `未知操作: ${input.action}` }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})


