import type { z } from "zod"
import { ProviderCatalog } from "./provider-catalog"
import { LLMError } from "./schema/errors"
import type { LLMMessage, ContentPart } from "./schema/messages"
import { getToolResultOutput } from "./schema/messages"
import { multimodalBridge, hasImageContent, modelHasVision } from "./transform"
import type { LLMRequest as LLMRequestSchema } from "./schema/options"
import { zodToJsonSchema } from "../shared/zod-converter"
import { isRetryableError as isUnifiedRetryable } from "../shared/errors"
import { logInfo } from "../system/logger"

export type ProviderType = string
export type { LLMMessage }

export interface SDKConfig {
  provider: string
  model: string
  apiKey: string
  apiUrl?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  /** 多模态视觉桥：主模型不支持 vision 时，将图片交给该视觉模型描述 */
  visionModel?: {
    provider: string
    model: string
    apiKey: string
    apiUrl?: string
    headers?: Record<string, string>
    options?: Record<string, unknown>
  }
  /** 主模型是否具备直接识图能力（自定义模型按类型标记，vision/multimodal 为 true） */
  modelVision?: boolean
}

export type LLMStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool_call"; toolCall: { id: string; name: string; arguments: string; index: number } }
  | { type: "done"; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
  | { type: "retry"; attempt: number; error: string }
  | { type: "error"; error: { message: string } }

export type LLMToolSet = Record<string, { description: string; inputSchema: z.ZodType; parameters?: z.ZodType }>

export interface LLMRequest2 {
  messages: LLMMessage[]
  tools?: LLMToolSet
  /** Prompt 缓存策略 */
  cache?: import("./schema/options").CachePolicy
}

/** @deprecated 使用 LLMRequest2 */
export type LLMRequest = LLMRequest2

export interface LLMClient {
  stream(request: LLMRequest2): AsyncGenerator<LLMStreamEvent>
  complete(request: LLMRequest2): Promise<{ content: string; toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }>
}

/** @internal 消息归一化：规范化 content parts，保留图片以便协议层序列化 */
export function convertMessages(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : m.content.map((part: ContentPart) => {
          if (part.type === "text") return { type: "text" as const, text: part.text }
          if (part.type === "reasoning") return { type: "reasoning" as const, text: part.text }
          if (part.type === "tool-call") return { type: "tool-call" as const, toolCallId: part.toolCallId, toolName: part.toolName, args: part.args }
          if (part.type === "tool-result") return { type: "tool-result" as const, toolCallId: part.toolCallId, toolName: part.toolName, output: getToolResultOutput(part.output) }
          // 保留图片 part，交给协议层序列化为 vision 格式
          if (part.type === "image") return { type: "image" as const, image: part.image, mediaType: part.mediaType }
          return { type: "text" as const, text: "" }
        }),
    tool_call_id: "tool_call_id" in m ? m.tool_call_id as string : undefined,
    // 回传 reasoning_content（DeepSeek thinking 模式必需，否则 400）
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
  }))
}

function convertTools(tools?: LLMToolSet): any {
  if (!tools || Object.keys(tools).length === 0) return undefined
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.inputSchema),
  }))
}

function isRetryableError(message: string): boolean {
  const code = parseInt(message.match(/HTTP (\d+)/)?.[1] || "0", 10)
  if (code >= 400 && code < 500) return code === 429
  if (code >= 500) return true
  return isUnifiedRetryable(new Error(message))
}

async function* withRetry(
  fn: () => AsyncGenerator<LLMStreamEvent>,
  maxRetries = 2,
  baseDelay = 800,
): AsyncGenerator<LLMStreamEvent> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      yield { type: "retry", attempt, error: lastError?.message || "Unknown error" }
      const delay = baseDelay * Math.pow(2, attempt - 1)
      await new Promise((r) => setTimeout(r, delay))
    }
    try {
      let hasError = false
      let emittedContent = false
      for await (const event of fn()) {
        if (event.type === "error") {
          hasError = true
          lastError = new Error(event.error.message)
          break
        }
        if (event.type === "delta" || event.type === "reasoning-start" || event.type === "reasoning-delta" || event.type === "tool_call") {
          emittedContent = true
        }
        yield event
      }
      if (!hasError) return
      // 已产出部分内容（delta/reasoning/tool_call）时禁止重试：重试会从头重放，
      // 导致已送达 UI 的前半段内容重复
      if (emittedContent) break
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
    }
    // 用统一的可重试判断（支持网络错误码/HTTP 状态/超时），Error 对象优先
    if (lastError && !isUnifiedRetryable(lastError)) break
  }
  yield { type: "error", error: { message: lastError?.message || "Unknown error" } }
}

export function createLLMClient(config: SDKConfig): LLMClient {
  const provider = ProviderCatalog.createRoute(
    config.provider,
    config.apiKey,
    config.apiUrl,
    config.headers,
  )

  async function* innerStream(request: LLMRequest2): AsyncGenerator<LLMStreamEvent> {
    try {
      // 多模态视觉桥：主模型无 vision 能力且消息含图片时，先由视觉模型描述替换
      let bridgeMessages = request.messages
      if (config.visionModel && hasImageContent(request.messages) && !modelHasVision(config.provider, config.model, config.modelVision)) {
        try {
          bridgeMessages = await multimodalBridge(request.messages, config.visionModel)
        } catch (bridgeErr) {
          // 桥失败回落到原消息（由协议层决定是否报"模型不支持图像"）
          console.warn("[multimodal bridge] vision analysis failed:", bridgeErr)
        }
      }

      // [Vision] 请求诊断：确认图片是否真正进入 LLM 请求
      let imgCount = 0
      let imgBytes = 0
      for (const m of request.messages) {
        if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p.type === "image" && p.image) {
              imgCount++
              imgBytes += p.image.length
            }
          }
        }
      }
      logInfo("Vision", `request provider=${config.provider} model=${config.model} modelVision=${String(config.modelVision)} bridge=${String(!!config.visionModel)} images=${imgCount} bytes=${imgBytes} hasImage=${String(hasImageContent(request.messages))}`)

      const llmRequest: LLMRequestSchema = {
        model: config.model,
        messages: convertMessages(bridgeMessages),
        tools: convertTools(request.tools),
        generation: config.options,
        // 默认启用缓存（Anthropic 需要显式 cache_control，OpenAI/DeepSeek 服务端自动）
        cache: request.cache ?? "auto",
      }

      let accumulatedArgs = ""
      let currentToolId = ""
      let currentToolName = ""

      for await (const event of provider.stream(llmRequest)) {
        switch (event.type) {
          case "text-delta":
            if (currentToolId) {
              accumulatedArgs += event.delta
            } else {
              yield { type: "delta", delta: event.delta }
            }
            break
          case "reasoning-start":
            yield { type: "reasoning-start", id: event.id }
            break
          case "reasoning-delta":
            yield { type: "reasoning-delta", id: event.id, delta: event.delta }
            break
          case "reasoning-end":
            yield { type: "reasoning-end", id: event.id }
            break
          case "tool-call":
            if (currentToolId && currentToolName) {
              yield { type: "tool_call", toolCall: { id: currentToolId, name: currentToolName, arguments: accumulatedArgs || "{}", index: 0 } }
            }
            currentToolId = event.id
            currentToolName = event.name
            accumulatedArgs = event.args || ""
            break
          case "finish":
            if (currentToolId && currentToolName) {
              yield { type: "tool_call", toolCall: { id: currentToolId, name: currentToolName, arguments: accumulatedArgs || "{}", index: 0 } }
            }
            yield { type: "done", usage: event.usage ? {
              promptTokens: event.usage.promptTokens,
              completionTokens: event.usage.completionTokens,
              totalTokens: event.usage.totalTokens,
              cacheReadTokens: event.usage.cacheReadTokens,
              cacheWriteTokens: event.usage.cacheWriteTokens,
            } : undefined }
            break
          case "error":
            logInfo("Vision", `provider stream error: ${event.message}`)
            yield { type: "error", error: { message: event.message } }
            break
        }
      }
    } catch (err: any) {
      logInfo("Vision", `provider stream threw: ${err?.message || String(err)}`)
      if (err instanceof LLMError) {
        yield { type: "error", error: { message: err.message } }
      } else {
        yield { type: "error", error: { message: err.message || String(err) } }
      }
    }
  }

  async function* stream(request: LLMRequest2): AsyncGenerator<LLMStreamEvent> {
    yield* withRetry(() => innerStream(request), 2, 800)
  }

  async function complete(request: LLMRequest2) {
    const textParts: string[] = []
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = []

    for await (const event of stream(request)) {
      if (event.type === "delta") {
        textParts.push(event.delta)
      } else if (event.type === "tool_call") {
        toolCalls.push({
          id: event.toolCall.id,
          type: "function",
          function: {
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          },
        })
      }
    }

    return { content: textParts.join(""), toolCalls }
  }

  return { stream, complete }
}
