import { LLMError, type LLMEvent } from "../schema"
import type { RouteConfig, RouteInstance, Protocol, Auth, Framing, Endpoint } from "./types"
import type { LLMMessage } from "../schema"

/** LLM 请求默认超时（未显式配置时使用，防流式请求永久挂起） */
export const DEFAULT_LLM_TIMEOUT = 120_000

function buildHeaders(auth: Auth, framing: Framing, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  switch (auth.type) {
    case "bearer":
      headers["Authorization"] = `Bearer ${auth.token}`
      break
    case "api-key":
      headers[auth.header] = auth.key
      break
  }
  if (framing === "sse") {
    headers["Accept"] = "text/event-stream"
  }
  return { ...headers, ...extra }
}

function makeStream(
  protocol: Protocol,
  url: string,
  headers: Record<string, string>,
  timeout: number | undefined,
): (request: Parameters<RouteInstance["stream"]>[0]) => AsyncGenerator<LLMEvent> {
  return async function* (request) {
    const body = protocol.serializeRequest(request)

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw LLMError.provider(protocol.name, `HTTP ${response.status}: ${errorText.slice(0, 1000)}`)
    }

    const contentType = response.headers.get("content-type") || ""
    const isSSE = contentType.includes("text/event-stream")

    if (!isSSE) {
      const data = await response.json()
      if (protocol.parseResponse) {
        const parsed = protocol.parseResponse(data)
        if (parsed.content) yield { type: "text-delta", delta: parsed.content }
      }
      yield { type: "finish", reason: "stop" }
      return
    }

    const reader = response.body?.getReader()
    if (!reader) throw LLMError.provider(protocol.name, "No response body")

    const decoder = new TextDecoder()
    let buffer = ""

    let finishYielded = false
    let reasoningOpen = false
    const reasoningId = "reasoning-0"

    // 对齐 opencode lifecycle：在协议无关层注入 reasoning-start/end。
    // reasoning-delta 首次出现 → reasoning-start；text/tool/finish 到达时若推理块仍开放 → reasoning-end。
    const beginReasoning = function* (): Generator<LLMEvent> {
      if (!reasoningOpen) {
        reasoningOpen = true
        yield { type: "reasoning-start", id: reasoningId }
      }
    }
    const endReasoning = function* (): Generator<LLMEvent> {
      if (reasoningOpen) {
        reasoningOpen = false
        yield { type: "reasoning-end", id: reasoningId }
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim()
            if (data === "[DONE]") {
              yield* endReasoning()
              if (!finishYielded) {
                yield { type: "finish", reason: "stop" }
              }
              return
            }
            try {
              const parsed = JSON.parse(data)
              const event = protocol.deserializeEvent(parsed)
              if (event) {
                if (event.type === "finish") {
                  yield* endReasoning()
                  finishYielded = true
                } else if (event.type === "reasoning-delta") {
                  yield* beginReasoning()
                } else if (event.type === "text-delta" || event.type === "tool-call") {
                  yield* endReasoning()
                }
                yield event
              }
            } catch {
              // skip unparseable chunks
            }
          }
        }
      }
      yield* endReasoning()
      if (!finishYielded) {
        yield { type: "finish", reason: "stop" }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        yield { type: "error", message: "Request timed out" }
        return
      }
      throw err
    } finally {
      reader.releaseLock()
    }
  }
}

function makeComplete(
  protocol: Protocol,
  url: string,
  headers: Record<string, string>,
  timeout: number | undefined,
): (request: Parameters<RouteInstance["complete"]>[0]) => Promise<{ content: string; toolCalls: Array<{ id: string; name: string; args: string }> }> {
  return async (request) => {
    const body = protocol.serializeRequest(request)
    body.stream = false

    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, Accept: "application/json" },
      body: JSON.stringify(body),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw LLMError.provider(protocol.name, `HTTP ${response.status}: ${errorText.slice(0, 1000)}`)
    }

    const data = await response.json()
    if (protocol.parseResponse) {
      return protocol.parseResponse(data)
    }
    return { content: JSON.stringify(data), toolCalls: [] }
  }
}

function computeUrl(endpoint: Endpoint): string {
  return `${endpoint.baseUrl.replace(/\/+$/, "")}${endpoint.path}`
}

export function makeRoute(config: RouteConfig): RouteInstance {
  const headers = buildHeaders(config.auth, config.framing, config.headers)
  const url = computeUrl(config.endpoint)
  // 未配置超时时用默认值，保证流式/完整请求不会无限挂起
  const timeout = config.timeout ?? DEFAULT_LLM_TIMEOUT

  const stream = makeStream(config.protocol, url, headers, timeout)
  const complete = makeComplete(config.protocol, url, headers, timeout)

  const instance: RouteInstance = {
    name: config.protocol.name,
    protocol: config.protocol,
    framing: config.framing,
    endpoint: config.endpoint,
    auth: config.auth,
    headers,
    timeout,
    stream,
    complete,

    with(overrides) {
      const newEndpoint: Endpoint = overrides.endpoint
        ? { ...config.endpoint, ...overrides.endpoint }
        : config.endpoint
      const newAuth = overrides.auth ?? config.auth
      const newFraming = overrides.framing ?? config.framing
      const newHeaders = { ...config.headers, ...overrides.headers }
      const newTimeout = overrides.timeout ?? timeout

      return makeRoute({
        protocol: config.protocol,
        endpoint: newEndpoint,
        auth: newAuth,
        framing: newFraming,
        headers: newHeaders,
        timeout: newTimeout,
      })
    },
  }

  return instance
}

export function executeRoute(
  route: RouteInstance,
  request: Parameters<RouteInstance["stream"]>[0],
): AsyncGenerator<LLMEvent> {
  return route.stream(request)
}
