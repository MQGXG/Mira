export interface GenerationOptions {
  [key: string]: unknown
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stop?: string[]
  seed?: number
  presencePenalty?: number
  frequencyPenalty?: number
}

export type CachePolicy = "auto" | "none" | {
  tools?: boolean
  system?: boolean
  messages?: "latest-user-message" | { tail: number }
  ttlSeconds?: number
}

export interface LLMRequest {
  model: string
  system?: string | string[]
  messages: import("./messages").LLMMessage[]
  tools?: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
  generation?: GenerationOptions
  cache?: CachePolicy
  maxSteps?: number
}
