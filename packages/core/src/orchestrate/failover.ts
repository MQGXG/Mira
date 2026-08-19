/**
 * Provider 降级链 — 当主 provider 失败时自动尝试备用
 * 参考 Hermes Agent error_classifier.py + run_conversation fallback 链
 */

import { createLLMClient } from "../llm/client"
import type { SDKConfig , LLMRequest, LLMStreamEvent } from "../llm/client"
import { isRetryableError } from "../shared/errors"
type ClientConfig = SDKConfig

export interface FallbackConfig {
  primary: ClientConfig
  fallbacks: ClientConfig[]
  /** 每次 provider 失败（降级或耗尽）时回调：attempt 从 1 起，provider 为失败 provider 名 */
  onProviderError?: (info: { attempt: number; provider: string; error: string }) => void
}

export class FallbackClient {
  private config: FallbackConfig
  private primary: ClientConfig
  private fallbacks: ClientConfig[]
  private currentProviderIndex = 0
  private lastError: string | null = null
  private fallbackUsed = false

  constructor(config: FallbackConfig) {
    this.config = config
    this.primary = config.primary
    this.fallbacks = config.fallbacks
  }

  get usedFallback(): boolean {
    return this.fallbackUsed
  }

  get currentProvider(): string {
    return this.currentProviderIndex === 0
      ? this.primary.provider
      : this.fallbacks[this.currentProviderIndex - 1]?.provider || "unknown"
  }

  get lastErrorMessage(): string | null {
    return this.lastError
  }

  async *stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const configs = [this.primary, ...this.fallbacks]

    for (let i = this.currentProviderIndex; i < configs.length; i++) {
      const config = configs[i]
      this.currentProviderIndex = i
      let shouldRetry = false

      try {
        const client = createLLMClient(config)
        const innerStream = client.stream(request)

        for await (const event of innerStream) {
          if (event.type === "error") {
            this.lastError = event.error?.message || "Unknown error"
            this.config.onProviderError?.({ attempt: i + 1, provider: config.provider || "unknown", error: this.lastError })
            if (this.shouldFallback(this.lastError) && i < configs.length - 1) {
              this.fallbackUsed = true
              shouldRetry = true
              yield {
                type: "delta",
                delta: `\n\n[⚠️ ${config.provider} 出错，切换到 ${configs[i + 1].provider} 重试...]\n\n`,
              }
              break
            }
            yield event
            return
          }
          yield event
        }
        if (shouldRetry) continue
        return
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.lastError = msg
        this.config.onProviderError?.({ attempt: i + 1, provider: config.provider || "unknown", error: msg })
        if (i < configs.length - 1) {
          this.fallbackUsed = true
          yield {
            type: "delta",
            delta: `\n\n[⚠️ ${config.provider} 连接失败 (${msg.slice(0, 80)})，切换到 ${configs[i + 1].provider}...]\n\n`,
          }
          continue
        }
        yield { type: "error", error: { message: msg } }
        return
      }
    }
  }

  private shouldFallback(error: string): boolean {
    const lower = error.toLowerCase()
    // 需要降级的错误类型
    if (lower.includes("rate limit") || lower.includes("429")) return true
    if (lower.includes("timeout") || lower.includes("timed out")) return true
    if (lower.includes("overloaded") || lower.includes("503")) return true
    if (lower.includes("service unavailable") || lower.includes("502")) return true
    if (lower.includes("internal server error") || lower.includes("500")) return true
    if (lower.includes("connection") || lower.includes("econnrefused")) return true
    // 不需要降级的错误
    if (lower.includes("auth") || lower.includes("401") || lower.includes("403")) return false
    if (lower.includes("invalid") || lower.includes("bad request") || lower.includes("400")) return false
    // 兜底：用统一的可重试判断（网络错误码/SSE 超时/socket hang up）
    return isRetryableError(new Error(error))
  }
}


