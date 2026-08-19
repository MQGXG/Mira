/**
 * OpenAI Responses API 协议
 * 参考 OpenCode 的 OpenAIResponses.route
 * OpenAI 最新 API，逐步取代 Chat Completions
 */

import type { LLMMessage, LLMEvent } from "../schema"
import type { Protocol } from "../route/types"

interface ResponseMessage {
  role: string
  content: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

function serializeResponsesMessages(messages: LLMMessage[]): ResponseMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      const out: ResponseMessage = { role: msg.role, content: msg.content }
      if (msg.role === "tool" && msg.tool_call_id) {
        out.tool_call_id = msg.tool_call_id
        out.role = "tool"
      }
      return out
    }
    const text = msg.content.filter((p) => p.type === "text").map((p) => p.text).join("")
    const toolCalls = msg.content.filter((p) => p.type === "tool-call")
    const toolResults = msg.content.filter((p) => p.type === "tool-result")

    if (toolResults.length > 0) {
      return {
        role: "tool",
        tool_call_id: toolResults[0].toolCallId,
        content: typeof toolResults[0].output === "string" ? toolResults[0].output : toolResults[0].output?.value || "",
      }
    }

    if (toolCalls.length > 0 && msg.role === "assistant") {
      return {
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.toolCallId,
          type: "function" as const,
          function: { name: tc.toolName, arguments: JSON.stringify(tc.args) },
        })),
      }
    }

    return { role: msg.role, content: text || null }
  })
}

export const OpenAIResponsesProtocol: Protocol = {
  name: "openai-responses",

  serializeRequest(request) {
    const body: Record<string, unknown> = {
      model: request.model,
      input: serializeResponsesMessages(request.messages),
      stream: true,
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    }
    const gen = request.generation || {}
    if (gen.maxTokens !== undefined) body.max_output_tokens = gen.maxTokens
    if (gen.temperature !== undefined) body.temperature = gen.temperature
    if (gen.topP !== undefined) body.top_p = gen.topP
    if (gen.seed !== undefined) body.seed = gen.seed
    return body
  },

  deserializeEvent(data): LLMEvent | null {
    const chunk = data as Record<string, unknown>
    const type = chunk.type as string | undefined

    if (type === "response.output_text.delta") {
      const delta = chunk.delta as string | undefined
      return delta ? { type: "text-delta" as const, delta } : null
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = chunk.delta as string | undefined
      return delta ? { type: "text-delta" as const, delta } : null
    }

    if (type === "response.function_call_arguments.done") {
      const callId = chunk.call_id as string
      const name = chunk.name as string
      const arguments_raw = chunk.arguments as string
      if (callId && name) {
        return { type: "tool-call" as const, id: callId, name, args: arguments_raw || "{}" }
      }
      return null
    }

    if (type === "response.completed") {
      const response = chunk.response as Record<string, unknown> | undefined
      const status = response?.status as string | undefined
      const reason = status === "incomplete" ? "length" : "stop"
      return { type: "finish" as const, reason }
    }

    if (type === "error") {
      const error = chunk.error as Record<string, unknown> | undefined
      return { type: "error" as const, message: (error?.message as string) || "Unknown error" }
    }

    return null
  },

  parseResponse(data): { content: string; toolCalls: Array<{ id: string; name: string; args: string }> } {
    const response = data as Record<string, unknown>
    const output = response.output as Array<Record<string, unknown>> | undefined
    if (!output) return { content: "", toolCalls: [] }

    let content = ""
    const toolCalls: Array<{ id: string; name: string; args: string }> = []

    for (const item of output) {
      if (item.type === "message") {
        const msgContent = item.content as Array<Record<string, unknown>> | undefined
        if (msgContent) {
          for (const part of msgContent) {
            if (part.type === "output_text") {
              content += (part.text as string) || ""
            }
            if (part.type === "function_call") {
              toolCalls.push({
                id: part.call_id as string,
                name: part.name as string,
                args: JSON.stringify(part.arguments || {}),
              })
            }
          }
        }
      }
    }

    return { content, toolCalls }
  },
}
