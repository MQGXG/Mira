import type { LLMMessage, LLMEvent, FinishReason } from "../schema"
import { getToolResultOutput } from "../schema/messages"
import type { Protocol } from "../route/types"

interface OpenAIChunk {
  choices?: Array<{
    delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
    // DeepSeek 专用缓存字段（服务端自动缓存）
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
}

export type { OpenAIChunk }

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string
      reasoning_content?: string
      tool_calls?: Array<{
        id: string
        function: { name: string; arguments: string }
      }>
    }
  }>
}

interface OpenAIMessage {
  role: string
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_call_id?: string
  reasoning_content?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
}

/** 图片 part → OpenAI image_url 内容块 */
function toImageContentPart(image: string, mediaType: string | undefined): { type: "image_url"; image_url: { url: string } } {
  return { type: "image_url" as const, image_url: { url: image } }
}

export function serializeMessages(messages: LLMMessage[]): OpenAIMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      const out: OpenAIMessage = { role: msg.role, content: msg.content }
      if (msg.role === "tool" && msg.tool_call_id) out.tool_call_id = msg.tool_call_id
      // 回传 reasoning_content（DeepSeek thinking 模式必需）
      if (msg.role === "assistant" && msg.reasoning_content) {
        (out as any).reasoning_content = msg.reasoning_content
      }
      return out
    }
    const parts = msg.content
    const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("")
    const reasoningText = parts.filter((p) => p.type === "reasoning").map((p) => p.text).join("")
    const imageParts = parts.filter((p) => p.type === "image")
    const toolCalls = parts.filter((p) => p.type === "tool-call")
    const toolResults = parts.filter((p) => p.type === "tool-result")

    if (toolResults.length > 0 && msg.role === "tool") {
      return {
        role: "tool",
        tool_call_id: toolResults[0].toolCallId,
        content: getToolResultOutput(toolResults[0].output),
      }
    }

    // 含图片的 user 消息：以多内容块数组发送（OpenAI vision 格式）
    if (imageParts.length > 0 && msg.role === "user") {
      const blocks: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      if (text) blocks.push({ type: "text", text })
      for (const img of imageParts) {
        blocks.push(toImageContentPart((img as { image: string }).image, (img as { mediaType?: string }).mediaType))
      }
      return { role: "user", content: blocks }
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
        ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
        ...(reasoningText ? { reasoning_content: reasoningText } : {}),
      }
    }

    // 空 assistant（无文本、无 reasoning、无 tool_calls）直接丢弃，避免 DeepSeek 400
    if (msg.role === "assistant" && !text && !reasoningText && !msg.reasoning_content) {
      return null as unknown as OpenAIMessage
    }

    return {
      role: msg.role,
      // 空内容用空字符串而非 null（DeepSeek 要求 assistant 必须有 content 或 tool_calls，reasoning-only 也算）
      content: (msg.role === "assistant" && (msg.reasoning_content || reasoningText)) ? (text || "") : (text || null),
      ...(msg.role === "assistant" && msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      ...(msg.role === "assistant" && reasoningText ? { reasoning_content: reasoningText } : {}),
    }
  })
  // 过滤掉空 assistant（返回 null 的占位）
  .filter((m): m is OpenAIMessage => m !== null)
}

export function deserializeChunk(chunk: OpenAIChunk): LLMEvent | null {
  const delta = chunk.choices?.[0]?.delta
  const finishReason = chunk.choices?.[0]?.finish_reason as FinishReason | undefined
  let usage: LLMEvent extends { type: "finish"; usage?: infer U } ? U : undefined = undefined

  // 提取 usage（如果存在）
  if (chunk.usage) {
    // DeepSeek 用 prompt_cache_hit_tokens，OpenAI 用 prompt_tokens_details.cached_tokens
    const cachedTokens = chunk.usage.prompt_cache_hit_tokens ?? chunk.usage.prompt_tokens_details?.cached_tokens
    usage = {
      promptTokens: chunk.usage.prompt_tokens || 0,
      completionTokens: chunk.usage.completion_tokens || 0,
      totalTokens: chunk.usage.total_tokens || 0,
      cacheReadTokens: cachedTokens,
      cacheWriteTokens: undefined,
    } as any
  }

  if (!delta) {
    if (finishReason) {
      return { type: "finish", reason: finishReason, usage }
    }
    // usage-only chunk（stream_options 启用时的最终 usage 块）
    if (usage) {
      return { type: "finish", reason: "stop", usage }
    }
    return null
  }

  if (delta.content) {
    return { type: "text-delta", delta: delta.content }
  }

  // DeepSeek thinking 模式：思考内容在 delta.reasoning_content
  if (delta.reasoning_content) {
    return { type: "reasoning-delta", id: "reasoning-0", delta: delta.reasoning_content }
  }

  if (delta.tool_calls) {
    const tc = delta.tool_calls[0]
    if (tc.function?.name) {
      return { type: "tool-call", id: tc.id || "", name: tc.function.name, args: tc.function.arguments || "" }
    }
    if (tc.function?.arguments) {
      return { type: "text-delta", delta: tc.function.arguments }
    }
  }

  // delta = {} 空对象，但有 finish_reason 或 usage
  if (finishReason || usage) {
    return { type: "finish", reason: finishReason || "stop", usage }
  }

  return null
}

export function getFinishReason(chunk: OpenAIChunk): string | undefined {
  return chunk.choices?.[0]?.finish_reason || undefined
}

/** 完整的 OpenAI Chat Protocol 实现 */
export const OpenAIChatProtocol: Protocol = {
  name: "openai-chat",
  serializeRequest(request) {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: serializeMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    const gen = request.generation || {}
    if (gen.maxTokens !== undefined) body.max_tokens = gen.maxTokens
    if (gen.temperature !== undefined) body.temperature = gen.temperature
    if (gen.topP !== undefined) body.top_p = gen.topP
    if (gen.stop !== undefined) body.stop = gen.stop
    if (gen.seed !== undefined) body.seed = gen.seed
    if (gen.presencePenalty !== undefined) body.presence_penalty = gen.presencePenalty
    if (gen.frequencyPenalty !== undefined) body.frequency_penalty = gen.frequencyPenalty
    return body
  },

  deserializeEvent(data) {
    return deserializeChunk(data as OpenAIChunk)
  },

  parseResponse(data) {
    const choice = (data as OpenAIResponse)?.choices?.[0]
    const content = choice?.message?.content || ""
    const toolCalls = (choice?.message?.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: tc.function.arguments,
    }))
    return { content, toolCalls }
  },
}
