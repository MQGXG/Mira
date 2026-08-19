/**
 * 团队通信工具 — 多 Agent 之间发送/接收消息
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { sendMessage, readInbox, clearInbox, getProtocolState, setProtocolState } from "../../orchestrate/team-bus"

export const teamTool = make({
  name: "team_tool",
  description: "团队 Agent 间通信：发送消息、读取收件箱、管理协议状态。用于多 Agent 协作",
  inputSchema: z.object({
    action: z.enum(["send", "read", "clear", "status", "set_protocol"]).describe("操作类型"),
    to: z.string().optional().describe("目标 Agent ID（send 时必需）"),
    type: z.enum(["task", "result", "question", "answer", "notification"]).optional().default("task").describe("消息类型"),
    content: z.string().optional().describe("消息内容（send 时必需）"),
    state: z.enum(["active", "shutdown", "plan_approval"]).optional().describe("协议状态（set_protocol 时必需）"),
  }),
  outputSchema: z.string(),
  execute: async (input, ctx) => {
    const agentId = ctx.agent || "agent"

    try {
      if (input.action === "send") {
        if (!input.to || !input.content) {
          return { success: false, error: "send 需要 to 和 content 参数" }
        }
        const msg = sendMessage(agentId, input.to, input.type || "task", input.content)
        return { success: true, output: `消息已发送至 ${input.to} (ID: ${msg.id})` }
      }

      if (input.action === "read") {
        const messages = readInbox(agentId)
        if (messages.length === 0) return { success: true, output: "收件箱为空" }
        return {
          success: true,
          output: messages.map((m) =>
            `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from} → 我: ${m.content.slice(0, 500)}`
          ).join("\n"),
        }
      }

      if (input.action === "clear") {
        clearInbox(agentId)
        return { success: true, output: "收件箱已清空" }
      }

      if (input.action === "status") {
        const state = getProtocolState()
        return { success: true, output: `协议状态: ${state}` }
      }

      if (input.action === "set_protocol") {
        if (!input.state) return { success: false, error: "set_protocol 需要 state 参数" }
        setProtocolState(input.state)
        return { success: true, output: `协议状态已切换为: ${input.state}` }
      }

      return { success: false, error: `未知操作: ${input.action}` }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})


