const SENSITIVE_KEYS = new Set(["apiKey", "api_key", "authorization", "x-api-key", "token", "password", "secret"])

export function sanitizeSensitiveFields(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitizeSensitiveFields)
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(obj)) {
      result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "***REDACTED***" : sanitizeSensitiveFields(val)
    }
    return result
  }
  return obj
}

export function sanitizeBody(body: string): string {
  try {
    return JSON.stringify(sanitizeSensitiveFields(JSON.parse(body)), null, 2)
  } catch {
    return body.slice(0, 500)
  }
}

export interface RouteConfig {
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
  timeout?: number
}

export class RouteClient {
  constructor(private config: RouteConfig) {}

  getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "")
  }

  getHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.config.apiKey ? { "Authorization": `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
      ...extra,
    }
  }

  async post(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    const url = `${this.getBaseUrl()}${path}`
    const controller = new AbortController()
    const timer = this.config.timeout ? setTimeout(() => controller.abort(), this.config.timeout) : undefined

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.getHeaders(extraHeaders),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      return response
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async *postStream(path: string, body: unknown): AsyncGenerator<Uint8Array> {
    const url = `${this.getBaseUrl()}${path}`
    const controller = new AbortController()
    // 修改点：为 SSE 读循环加"读空闲超时"（默认 60s），防止 provider 建立连接后挂起
    // 导致 reader.read() 无限等待、长期占用 Core 单线程事件循环（health 偶发 ECONNRESET 的诱因）。
    const idleMs = this.config.timeout ?? 60_000

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { ...this.getHeaders(), Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      controller.abort()
      throw err
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[RouteClient] HTTP ${response.status} from ${url}: ${errorText.slice(0, 500)}`)
      const sanitized = sanitizeBody(typeof body === "string" ? body : (JSON.stringify(body) ?? "undefined"))
      console.debug(`[RouteClient] Request body (sanitized): ${sanitized.slice(0, 2000)}`)
      controller.abort()
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 1000)}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      controller.abort()
      throw new Error("No response body")
    }

    const decoder = new TextDecoder()
    let buffer = ""
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const resetIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(), idleMs)
    }

    try {
      resetIdleTimer()
      while (true) {
        const { done, value } = await reader.read()
        resetIdleTimer()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim()
            if (data === "[DONE]") return
            yield new TextEncoder().encode(data)
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`SSE read timed out after ${idleMs}ms of inactivity`)
      }
      throw err
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      reader.releaseLock()
      controller.abort()
    }
  }
}
