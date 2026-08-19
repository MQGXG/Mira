import type { LLMMessage, LLMEvent, FinishReason } from "../schema"
import type { Protocol } from "../route/types"

interface GeminiContent {
  role: "user" | "model"
  parts: GeminiPart[]
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }

interface GeminiCandidate {
  content: GeminiContent
  finishReason?: string
}

interface GeminiResponse {
  candidates: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: GeminiContent
    finishReason?: string
  }>
  usageMetadata?: GeminiResponse["usageMetadata"]
}

function convertMessages(messages: LLMMessage[]): GeminiContent[] {
  const result: GeminiContent[] = []
  for (const msg of messages) {
    if (msg.role === "system") continue
    const role = msg.role === "assistant" ? "model" : "user"
    const parts: GeminiPart[] = []

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content })
    } else {
      for (const part of msg.content) {
        if (part.type === "text") {
          parts.push({ text: part.text })
        } else if (part.type === "image") {
          const img = part as { image: string; mediaType?: string }
          const m = /^data:([^;]+);base64,(.+)$/s.exec(img.image)
          if (m) {
            parts.push({ inlineData: { mimeType: img.mediaType || m[1], data: m[2] } })
          } else {
            parts.push({ fileData: { mimeType: img.mediaType || "image/png", fileUri: img.image } })
          }
        } else if (part.type === "tool-call") {
          parts.push({
            functionCall: { name: part.toolName, args: part.args as Record<string, unknown> },
          })
        } else if (part.type === "tool-result") {
          const output = typeof part.output === "string" ? part.output : part.output?.value || ""
          parts.push({
            functionResponse: {
              name: part.toolName,
              response: { content: output },
            },
          })
        }
      }
    }
    result.push({ role, parts })
  }
  return result
}

function extractSystemMessage(messages: LLMMessage[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n")
}

export const GeminiProtocol: Protocol = {
  name: "gemini",

  serializeRequest(request) {
    const systemInstruction = extractSystemMessage(request.messages)
    const body: Record<string, unknown> = {
      contents: convertMessages(request.messages),
      generationConfig: {},
    }
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] }
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }]
    }
    const gen = request.generation || {}
    if (gen.maxTokens !== undefined) body.generationConfig = { ...(body.generationConfig as object), maxOutputTokens: gen.maxTokens }
    if (gen.temperature !== undefined) body.generationConfig = { ...(body.generationConfig as object), temperature: gen.temperature }
    if (gen.topP !== undefined) body.generationConfig = { ...(body.generationConfig as object), topP: gen.topP }
    if (gen.stop !== undefined) body.generationConfig = { ...(body.generationConfig as object), stopSequences: Array.isArray(gen.stop) ? gen.stop : [gen.stop] }
    return body
  },

  deserializeEvent(data): LLMEvent | null {
    const chunk = data as GeminiStreamChunk
    if (!chunk.candidates || chunk.candidates.length === 0) {
      if (chunk.usageMetadata) {
        return { type: "finish", reason: "stop" }
      }
      return null
    }

    const candidate = chunk.candidates[0]
    if (candidate.finishReason) {
      return { type: "finish", reason: mapFinishReason(candidate.finishReason) }
    }

    const content = candidate.content
    if (!content || !content.parts) return null

    for (const part of content.parts) {
      if ("text" in part && part.text) {
        return { type: "text-delta", delta: part.text }
      }
      if ("functionCall" in part) {
        return {
          type: "tool-call",
          id: part.functionCall.name,
          name: part.functionCall.name,
          args: JSON.stringify(part.functionCall.args),
        }
      }
    }
    return null
  },

  parseResponse(data): { content: string; toolCalls: Array<{ id: string; name: string; args: string }> } {
    const response = data as GeminiResponse
    const candidate = response.candidates?.[0]
    if (!candidate) return { content: "", toolCalls: [] }

    const parts = candidate.content?.parts || []
    let content = ""
    const toolCalls: Array<{ id: string; name: string; args: string }> = []

    for (const part of parts) {
      if ("text" in part && part.text) {
        content += part.text
      }
      if ("functionCall" in part) {
        toolCalls.push({
          id: part.functionCall.name,
          name: part.functionCall.name,
          args: JSON.stringify(part.functionCall.args),
        })
      }
    }

    return { content, toolCalls }
  },
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "STOP": return "stop"
    case "MAX_TOKENS": return "length"
    case "SAFETY": return "content-filtered"
    case "RECITATION": return "content-filtered"
    case "OTHER": return "stop"
    default: return "unknown"
  }
}
