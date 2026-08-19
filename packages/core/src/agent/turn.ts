import { createLLMClient, type LLMToolSet, type LLMMessage } from "../llm/client"
import type { AgentEvent } from "../types"
import type { ContextManager } from "../session/context"
import { sanitizeMessagesForLLM } from "../shared/message-utils"

export interface LLMTurnConfig {
  provider: string
  model: string
  apiKey: string
  apiUrl: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  visionModel?: {
    provider: string
    model: string
    apiKey: string
    apiUrl?: string
    headers?: Record<string, string>
    options?: Record<string, unknown>
  }
  /** 主模型是否支持直接识图（vision/multimodal 直发，其余 false） */
  modelVision?: boolean
}

export interface LLMTurnInput {
  messages: LLMMessage[]
  tools: LLMToolSet
  config: LLMTurnConfig
  signal?: AbortSignal
  contextManager?: ContextManager
  sessionID?: string
}

export interface LLMTurnOutput {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  compacted: boolean
  /** DeepSeek thinking 模式的思考内容 */
  reasoningContent?: string
}

const MAX_ATTEMPTS = 5

export async function* runLLMTurn(
  input: LLMTurnInput,
): AsyncGenerator<AgentEvent, LLMTurnOutput> {
  const { messages, tools, config, signal, contextManager, sessionID } = input
  const client = createLLMClient({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    headers: config.headers,
    options: config.options,
    visionModel: config.visionModel,
    modelVision: config.modelVision,
  })

  let currentText = ""
  let currentReasoning = ""
  const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = []
  let attemptCount = 0
  let compacted = false

  while (attemptCount < MAX_ATTEMPTS) {
    attemptCount++
    pendingToolCalls.length = 0
    currentText = ""
    currentReasoning = ""

    try {
      const stream = client.stream({ messages: sanitizeMessagesForLLM(messages), tools })
      for await (const event of stream) {
        if (event.type === "delta") {
          currentText += event.delta
          yield { type: "content" as const, text: event.delta }
        } else if (event.type === "reasoning-delta") {
          currentReasoning += event.delta
        } else if (event.type === "reasoning-start" || event.type === "reasoning-end") {
          // 推理块生命周期事件，无需处理
        } else if (event.type === "tool_call" && event.toolCall) {
          pendingToolCalls.push({
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          })
        } else if (event.type === "error") {
          throw new Error(event.error?.message || "LLM stream error")
        } else if (event.type === "done") {
          break
        }
      }
      return { text: currentText, toolCalls: pendingToolCalls, compacted, reasoningContent: currentReasoning }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const msg = error.message.toLowerCase()

      if (
        msg.includes("prompt_too_long") ||
        msg.includes("context_length_exceeded") ||
        msg.includes("too many tokens")
      ) {
        if (!contextManager || !sessionID) {
          yield { type: "error" as const, message: `Context overflow: ${error.message}` }
          return { text: currentText, toolCalls: [], compacted }
        }
        yield { type: "thinking" as const, text: "⚠️ Context too long, performing emergency compaction..." }
        const compactedMessages = await contextManager.reactiveCompact(messages, sessionID)
        if (compactedMessages.length < messages.length) {
          messages.length = 0
          messages.push(...compactedMessages)
          compacted = true
        }
        continue
      }

      if (
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("529") ||
        msg.includes("overloaded")
      ) {
        if (attemptCount >= MAX_ATTEMPTS) {
          yield { type: "error" as const, message: `Rate limited after ${MAX_ATTEMPTS} retries: ${error.message}` }
          return { text: currentText, toolCalls: [], compacted }
        }
        const delay = Math.min(1000 * Math.pow(2, attemptCount - 1) + Math.random() * 1000, 32000)
        yield { type: "thinking" as const, text: `⏳ Rate limited, retrying in ${Math.round(delay / 1000)}s (${attemptCount}/${MAX_ATTEMPTS})...` }
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      yield { type: "error" as const, message: error.message }
      return { text: currentText, toolCalls: [], compacted }
    }
  }

  return { text: currentText, toolCalls: pendingToolCalls, compacted }
}


