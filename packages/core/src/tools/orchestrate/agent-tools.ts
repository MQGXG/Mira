/**
 * Agent 子代理工具
 * 支持 spawn/wait/list/cancel/status 操作
 * 集成：注册表持久化、任务门控、标准化返回协议、上下文继承
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import type { SubagentManager } from "../../orchestrate/subagent"
import type { SubagentInfo, ContextMode } from "../../orchestrate/subagent"
import type { AgentConfig } from "../../agent/agent"

let manager: SubagentManager | null = null
let parentConfig: Partial<AgentConfig> | null = null

export function setSubagentManager(m: SubagentManager): void {
  manager = m
}

export function getSubagentManager(): SubagentManager | null {
  return manager
}

export function setParentConfig(config: Partial<AgentConfig>): void {
  parentConfig = { ...config }
}

export function getChildConfig(overrides?: { model?: string; sessionID?: string }): AgentConfig {
  const base: AgentConfig = {
    sessionID: overrides?.sessionID || parentConfig?.sessionID || "",
    workspace: parentConfig?.workspace || "",
    model: overrides?.model || parentConfig?.model || "gpt-4o-mini",
    apiKey: parentConfig?.apiKey || "",
    apiUrl: parentConfig?.apiUrl || "",
    provider: parentConfig?.provider || "openai",
    maxSteps: Math.min(parentConfig?.maxSteps || 10, 5),
  }
  if (parentConfig?.headers) base.headers = parentConfig.headers
  if (parentConfig?.options) base.options = parentConfig.options
  return base
}

// ── spawn_agent ───────────────────────────────────────

export const spawnAgentTool = make({
  name: "spawn_agent",
  description: `启动一个或多个子 Agent 执行独立子任务。支持三种上下文继承模式：
- none: 只传 prompt（默认）
- state: 注入父会话的 checkpoint 摘要
- full: 共享父会话的前缀缓存

子 Agent 必须按以下格式输出结果：
**Status**: success | partial | failed | blocked
**Summary**: <一句话概括>`,
  inputSchema: z.object({
    tasks: z.array(z.object({
      description: z.string().describe("子任务描述"),
      prompt: z.string().optional().describe("额外提示/上下文"),
      context: z.enum(["none", "state", "full"] as const).optional().default("none").describe("上下文继承模式"),
      mode: z.enum(["subagent", "peer"] as const).optional().default("subagent").describe("subagent: 共享会话; peer: 独立会话"),
      model: z.string().optional().describe("子 Agent 模型（默认继承父 Agent）"),
    })).min(1).max(5),
    wait: z.boolean().optional().describe("是否等待全部完成再返回（默认 false）"),
    timeout: z.number().optional().describe("等待超时（秒，默认 300）"),
    outputSchema: z.record(z.string(), z.any()).optional().describe("JSON Schema 对象：所有子 Agent 的最终结果将以该结构 JSON 输出（作为交付内容，便于结构化解析）"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const mgr = manager
    if (!mgr) return { success: false, error: "Subagent system not initialized" }

    try {
      const childConfig = getChildConfig({
        model: input.tasks[0].model || parentConfig?.model || undefined,
        sessionID: ctx.sessionID,
      })

      const spawned = mgr.spawnMany(
        input.tasks.map((t) => {
          // 注册任务到门控
          mgr.getGate().registerTask("pending", t.description)

          // context=full 时传递父上下文
          const options: any = { prompt: t.prompt || t.description, context: t.context || "none", mode: t.mode || "subagent" }
          if (input.outputSchema) {
            options.outputSchema = input.outputSchema
          }
          if (t.context === "full") {
            options.parentContext = (parentConfig as any)?.parentContext || []
          }

          return {
            description: t.description,
            config: { ...childConfig, sessionID: `${childConfig.sessionID}-${Date.now().toString(36)}` },
            options,
          }
        }),
      )

      const lines = spawned.map((s) => `- ${s.id}: ${s.description} [${s.status}]`).join("\n")

      if (input.wait) {
        const ids = spawned.map((s) => s.id)
        const results = await mgr.waitAll(ids, (input.timeout || 300) * 1000)
        const summary = results.map((r) => {
          const statusIcon = r.status === "completed" ? "✅" : r.status === "failed" ? "❌" : "⏳"
          return `  ${r.id}: ${statusIcon} ${r.status}\n  ${(r.result || r.error || "").slice(0, 500)}`
        }).join("\n\n")
        return { success: true, output: `已启动 ${spawned.length} 个子 Agent 并等待完成：\n\n${summary}` }
      }

      return {
        success: true,
        output: `已启动 ${spawned.length} 个子 Agent（后台执行）：\n\n${lines}\n\n使用 wait_agents 检查进度或获取结果。`,
      }
    } catch (err) {
      return { success: false, error: `spawn_agent 失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})

// ── wait_agents ───────────────────────────────────────

export const waitAgentsTool = make({
  name: "wait_agents",
  description: "等待一个或多个子 Agent 完成并获取结果。支持等待全部或任意一个先完成。",
  inputSchema: z.object({
    agent_ids: z.array(z.string()).min(1).max(10).describe("子 Agent ID 列表"),
    mode: z.enum(["all", "any"]).optional().describe("'all' 等待全部（默认），'any' 任意一个即返回"),
    timeout: z.number().optional().describe("超时（秒，默认 300）"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const mgr = manager
    if (!mgr) return { success: false, error: "Subagent system not initialized" }

    try {
      const timeoutMs = (input.timeout || 300) * 1000
      const results = input.mode === "any"
        ? [await mgr.waitAny(input.agent_ids, timeoutMs)].filter((x): x is SubagentInfo => x !== null)
        : await mgr.waitAll(input.agent_ids, timeoutMs)

      if (results.length === 0) {
        return { success: true, output: "没有子 Agent 返回结果（可能超时或被取消）" }
      }

      const summary = results.map((r) => {
        const icon = r.status === "completed" ? "✅" : r.status === "failed" ? "❌" : r.status === "cancelled" ? "⊘" : "⏳"
        const duration = r.startedAt && r.completedAt
          ? ` (${((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000).toFixed(1)}s)`
          : ""
        return [
          `### ${icon} ${r.id}${duration}`,
          `状态: ${r.status}`,
          `描述: ${r.description}`,
          r.result ? `结果:\n${r.result.slice(0, 2000)}` : "",
          r.error ? `错误: ${r.error}` : "",
        ].filter(Boolean).join("\n")
      }).join("\n\n")

      return { success: true, output: summary }
    } catch (err) {
      return { success: false, error: `wait_agents 失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})

// ── list_subagents ────────────────────────────────────

export const listSubagentsTool = make({
  name: "list_subagents",
  description: "列出所有活跃或指定状态的子 Agent。可用于检查后台任务的进度。",
  inputSchema: z.object({
    status: z.enum(["running", "pending", "completed", "failed", "cancelled", "orphaned"]).optional().describe("按状态筛选"),
    parent_id: z.string().optional().describe("按父 Actor ID 筛选"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const mgr = manager
    if (!mgr) return { success: false, error: "Subagent system not initialized" }

    try {
      const filter: Record<string, any> = {}
      if (input.parent_id) filter.parentId = input.parent_id
      if (input.status) filter.status = input.status

      const agents = mgr.list(Object.keys(filter).length > 0 ? filter : undefined)

      if (agents.length === 0) {
        return { success: true, output: input.status
          ? `没有状态为 "${input.status}" 的子 Agent`
          : "没有活跃的子 Agent" }
      }

      const lines = agents.map((a) => {
        const icon = { pending: "○", running: "●", completing: "◐", completed: "✓", failed: "✗", cancelled: "⊘", orphaned: "?", stuck: "⏸" }[a.status]
        return `${icon} ${a.id}: ${a.description.slice(0, 80)} [${a.status}]`
      })

      return { success: true, output: `共 ${agents.length} 个子 Agent：\n\n${lines.join("\n")}` }
    } catch (err) {
      return { success: false, error: `list_subagents 失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
})
