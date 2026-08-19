/**
 * Agent 节点适配器 — 让 Graph 节点真正驱动 Agent.run()
 * 复用 subagent 的驱动模式：new Agent() + for await run()
 */

import { Agent } from "../../agent/agent"
import type { AgentConfig, AgentEvent } from "../../agent/agent"
import type { ToolRegistry } from "../../system/registry"
import type { LLMMessage } from "../../llm/client"
import { logError } from "../../system/logger"

export interface RunAgentNodeOptions {
  registry: ToolRegistry
  config: AgentConfig
  prompt: string
  history?: LLMMessage[]
  /** 每次 AgentEvent 回调（用于转发到图事件流） */
  onEvent?: (event: AgentEvent) => void
  /** 是否收集事件轨迹（供 extractFiles / UI 展示） */
  collectEvents?: boolean
}

export interface RunAgentNodeResult {
  output: string
  usage: { totalTokens: number }
  events: AgentEvent[]
  status: "completed" | "failed"
  error?: string
}

/**
 * 驱动一个完整 Agent.run()（含工具循环/doom 检测/压缩管线）
 * 每个节点内部就是一个完整 Loop —— 对应文章"Graph 节点内部跑 Loop"
 */
export async function runAgentNode(opts: RunAgentNodeOptions): Promise<RunAgentNodeResult> {
  const agent = new Agent(
    opts.registry,
    opts.config.apiKey,
    opts.config.apiUrl,
    opts.config.workspace,
  )

  let text = ""
  let totalTokens = 0
  const events: AgentEvent[] = opts.collectEvents ? [] : (null as unknown as AgentEvent[])

  try {
    for await (const event of agent.run(opts.prompt, opts.history || [], {
      ...opts.config,
      sessionID: opts.config.sessionID,
    })) {
      opts.onEvent?.(event)
      if (opts.collectEvents) events.push(event)
      if (event.type === "content") text += event.text
      if (event.type === "finish" && event.usage?.totalTokens) {
        totalTokens += event.usage.totalTokens
      }
      if (event.type === "error") {
        logError("[Graph:runAgentNode] Agent error", event.message)
      }
    }
  } catch (err) {
    return {
      output: text,
      usage: { totalTokens },
      events,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }

  return { output: text, usage: { totalTokens }, events, status: "completed" }
}
