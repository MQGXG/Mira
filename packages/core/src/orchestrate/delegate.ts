/**
 * 子代理系统 — 允许 Agent 将任务委派给独立运行的子 Agent
 * 子 Agent 继承父 Agent 的注册表与权限子集，拥有独立会话和预算
 */

import type { AgentConfig } from "../agent/agent"
import type { ToolRegistry } from "../system/registry"
import type { PermissionRule } from "../system/permission";
import { PermissionSet } from "../system/permission"
import type { LLMMessage } from "../llm/client";
import { createLLMClient } from "../llm/client"
import { IterationBudget } from "../task/budget"
import { evaluateToolCalls } from "../system/permission/gate"

export interface DelegateTask {
  id: string
  parentSessionID: string
  task: string
  config: AgentConfig
  permissions: PermissionRule[]
  result: string
  status: "pending" | "running" | "done" | "failed"
  startedAt: number
  completedAt: number
}

const activeDelegations = new Map<string, DelegateTask>()

/** 生成子代理权限（父权限的子集 + 更严格的默认规则） */
function childPermissions(parentRules?: PermissionRule[]): PermissionSet {
  if (!parentRules || parentRules.length === 0) {
    // 默认子代理权限：只读 + 搜索
    return new PermissionSet([
      { action: "read_file", resource: "*", effect: "allow" },
      { action: "list_files", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "web_search", resource: "*", effect: "allow" },
      { action: "web_browse", resource: "*", effect: "allow" },
      { action: "data_analysis", resource: "*", effect: "allow" },
      { action: "*", resource: "*", effect: "ask" },
    ])
  }

  // 继承父权限，但写操作降级为 ask
  const inherited = parentRules.filter((r) => {
    const isWrite = ["write_file", "edit_file", "bash", "run_code"].some((w) =>
      r.action === w || r.action === "*"
    )
    return !isWrite
  })

  return new PermissionSet([
    ...inherited,
    { action: "write_file", resource: "*", effect: "ask" },
    { action: "edit_file", resource: "*", effect: "ask" },
    { action: "bash", resource: "*", effect: "ask" },
    { action: "run_code", resource: "*", effect: "ask" },
  ])
}

/** 运行子代理 */
export async function runDelegate(
  id: string,
  parentSessionID: string,
  task: string,
  config: AgentConfig,
  registry: ToolRegistry,
  parentPermissions?: PermissionRule[],
): Promise<string> {
  const delegation: DelegateTask = {
    id,
    parentSessionID,
    task,
    config,
    permissions: parentPermissions || [],
    result: "",
    status: "running",
    startedAt: Date.now(),
    completedAt: 0,
  }
  activeDelegations.set(id, delegation)

  try {
    const childSessionID = `${parentSessionID}-sub-${id}`
    const childConfig: AgentConfig = {
      ...config,
      sessionID: childSessionID,
      maxSteps: Math.min(config.maxSteps || 10, 5), // 子代理步数上限
      permissions: childPermissions(parentPermissions),
      systemPrompt: `You are a sub-agent tasked with a specific subtask. 
Focus ONLY on completing the assigned task. 
Do not ask for additional context or clarification.
When you are done, provide a clear summary of what you accomplished.

Your task: ${task}`,
    }

    const messages: LLMMessage[] = [
      { role: "system", content: childConfig.systemPrompt || "" },
      { role: "user", content: task },
    ]

    const toolSet = registry.materialize(childConfig.permissions).definitions
    const client = createLLMClient({
      provider: config.provider || "openai",
      model: config.model,
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      headers: config.headers,
      options: config.options,
    })

    const budget = new IterationBudget(childConfig.maxSteps || 5)
    let finalText = ""

    while (budget.consume()) {
      const stream = client.stream({ messages, tools: toolSet })
      let currentText = ""
      const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = []

      for await (const event of stream) {
        if (event.type === "delta") {
          currentText += event.delta
        } else if (event.type === "tool_call" && event.toolCall) {
          pendingToolCalls.push({
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          })
        } else if (event.type === "error") {
          finalText = `子代理错误: ${event.error?.message || ""}`
          delegation.status = "failed"
          delegation.result = finalText
          delegation.completedAt = Date.now()
          return finalText
        } else if (event.type === "done") {
          break
        }
      }

      const toolCallsArray = pendingToolCalls
        .filter((tc) => tc.id && tc.name)
        .map((tc) => ({
          id: tc.id, type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))

      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: currentText },
          ...toolCallsArray.map((tc) => ({
            type: "tool-call" as const,
            toolCallId: tc.id,
            toolName: tc.function.name,
            args: JSON.parse(tc.function.arguments),
          })),
        ],
      })

      if (currentText) finalText = currentText

      if (toolCallsArray.length === 0) break

      // 执行工具
      const ctx = {
        sessionID: childSessionID,
        workspace: config.workspace,
        mode: "assistant" as const,
        agent: "delegate" as const,
        assistantMessageID: id,
        toolCallID: "",
        // 透传父 Agent 凭据，支持子 Agent 内嵌套委托/工具继承配置
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
        provider: config.provider,
        model: config.model,
        headers: config.headers,
        options: config.options,
      }

      // 权限门控：子代理不能请求用户授权，权限不足直接拒绝
      const approvals = evaluateToolCalls(toolCallsArray, registry, childConfig.permissions)
      for (const ev of approvals) {
        if (ev.needsApproval) {
          messages.push({
            role: "tool",
            content: [{ type: "tool-result" as const, toolCallId: ev.toolCall.id, toolName: ev.toolCall.name, output: { type: "text" as const, value: `[Permission denied: ${ev.toolCall.name} — sub-agent cannot request permission]` } }],
            tool_call_id: ev.toolCall.id,
          })
          continue
        }
        const result = await registry.execute(ev.toolCall.name, ev.args, ctx)
        const text = result.output || result.error || ""
        messages.push({
          role: "tool",
          content: [{ type: "tool-result" as const, toolCallId: ev.toolCall.id, toolName: ev.toolCall.name, output: { type: "text" as const, value: text } }],
          tool_call_id: ev.toolCall.id,
        })
      }
    }

    delegation.result = finalText
    delegation.status = "done"
    delegation.completedAt = Date.now()
    return finalText
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    delegation.result = msg
    delegation.status = "failed"
    delegation.completedAt = Date.now()
    return `子代理执行失败: ${msg}`
  }
}

/** 获取委派任务状态 */
export function getDelegationStatus(id: string): DelegateTask | undefined {
  return activeDelegations.get(id)
}

/** 列出所有活跃委派 */
export function listActiveDelegations(): DelegateTask[] {
  return Array.from(activeDelegations.values()).filter((d) => d.status === "pending" || d.status === "running")
}

/** 清理完成的委派 */
export function cleanupDelegations(olderThanMs = 300000): void {
  const cutoff = Date.now() - olderThanMs
  for (const [id, task] of activeDelegations) {
    if (task.completedAt > 0 && task.completedAt < cutoff) {
      activeDelegations.delete(id)
    }
  }
}


