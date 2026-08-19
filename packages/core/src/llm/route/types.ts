import type { LLMMessage, LLMEvent } from "../schema"
import type { CachePolicy } from "../schema/options"

export interface Endpoint {
  baseUrl: string
  path: string
}

export type Auth =
  | { type: "bearer"; token: string }
  | { type: "api-key"; key: string; header: string }
  | { type: "none" }

export type Framing = "sse" | "json"

export interface Protocol {
  name: string
  serializeRequest(request: {
    model: string
    messages: LLMMessage[]
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    generation?: Record<string, unknown>
    cache?: CachePolicy
  }): Record<string, unknown>

  deserializeEvent(data: unknown): LLMEvent | null

  parseResponse?(response: unknown): { content: string; toolCalls: Array<{ id: string; name: string; args: string }> }
}

export interface RouteConfig {
  protocol: Protocol
  endpoint: Endpoint
  auth: Auth
  framing: Framing
  headers?: Record<string, string>
  timeout?: number
}

export interface RouteInstance {
  readonly name: string
  readonly protocol: Protocol
  readonly framing: Framing
  readonly endpoint: Endpoint
  readonly auth: Auth
  readonly headers: Readonly<Record<string, string>>
  readonly timeout: number | undefined

  stream(request: {
    model: string
    messages: LLMMessage[]
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    generation?: Record<string, unknown>
    cache?: CachePolicy
  }): AsyncGenerator<LLMEvent>

  complete(request: {
    model: string
    messages: LLMMessage[]
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    generation?: Record<string, unknown>
    cache?: CachePolicy
  }): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: string }> }>

  with(overrides: Partial<{
    endpoint: Partial<Endpoint>
    auth: Auth
    headers: Record<string, string>
    framing: Framing
    timeout: number
  }>): RouteInstance
}
