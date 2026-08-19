export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type FinishReason = "stop" | "length" | "tool-calls" | "error" | "content-filtered" | "unknown"

export type LLMEvent =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-call"; id: string; name: string; args: string }
  | { type: "finish"; reason: FinishReason; usage?: TokenUsage }
  | { type: "error"; message: string }

export const LLMEvent = {
  textDelta(delta: string): LLMEvent { return { type: "text-delta", delta } },
  reasoningStart(id: string): LLMEvent { return { type: "reasoning-start", id } },
  reasoningDelta(id: string, delta: string): LLMEvent { return { type: "reasoning-delta", id, delta } },
  reasoningEnd(id: string): LLMEvent { return { type: "reasoning-end", id } },
  toolCall(id: string, name: string, args: string): LLMEvent { return { type: "tool-call", id, name, args } },
  finish(reason: FinishReason, usage?: TokenUsage): LLMEvent { return { type: "finish", reason, usage } },
  error(message: string): LLMEvent { return { type: "error", message } },
}
