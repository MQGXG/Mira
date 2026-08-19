/**
 * 结构化错误恢复 — 错误分类 + 指数退避 + 恢复策略
 */

export type ErrorCategory = "rate_limit" | "overload" | "timeout" | "context_overflow" | "auth" | "invalid_request" | "network" | "unknown"

export type RecoveryAction = "retry" | "retry_backoff" | "compact_retry" | "fallback" | "abort"

export interface RecoveryState {
  retryCount: number
  backoffMs: number
  maxRetries: number
  lastError: string
  lastCategory: ErrorCategory
  compactedBeforeRetry: boolean
  fallbackUsed: boolean
}

export function classifyError(error: string): ErrorCategory {
  const lower = error.toLowerCase()
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit"
  if (lower.includes("overloaded") || lower.includes("503") || lower.includes("502")) return "overload"
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("time_out")) return "timeout"
  if (lower.includes("context_length") || lower.includes("max_tokens") || lower.includes("context") && lower.includes("exceed")) return "context_overflow"
  if (lower.includes("auth") || lower.includes("401") || lower.includes("403") || lower.includes("api_key")) return "auth"
  if (lower.includes("invalid") || lower.includes("400") || lower.includes("bad request") || lower.includes("missing field")) return "invalid_request"
  if (lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("econnreset") || lower.includes("network") || lower.includes("fetch")) return "network"
  return "unknown"
}

export function determineAction(category: ErrorCategory, state: RecoveryState): RecoveryAction {
  if (category === "auth" || category === "invalid_request") return "abort"
  if (category === "context_overflow") return state.compactedBeforeRetry ? "fallback" : "compact_retry"
  if (category === "rate_limit" || category === "overload") return state.retryCount < state.maxRetries ? "retry_backoff" : "fallback"
  if (category === "timeout" || category === "network") return state.retryCount < state.maxRetries ? "retry" : "fallback"
  return state.retryCount < state.maxRetries ? "retry" : "abort"
}

export function getBackoffMs(retryCount: number): number {
  // 指数退避 + 抖动: 1s, 2s, 4s, 8s, 16s + 随机抖动
  const base = Math.min(1000 * Math.pow(2, retryCount), 30000)
  const jitter = Math.random() * base * 0.3
  return Math.floor(base + jitter)
}

export function createRecoveryState(maxRetries = 3): RecoveryState {
  return {
    retryCount: 0,
    backoffMs: 0,
    maxRetries,
    lastError: "",
    lastCategory: "unknown",
    compactedBeforeRetry: false,
    fallbackUsed: false,
  }
}

export function recoveryAdvice(error: string, state: RecoveryState): { action: RecoveryAction; delayMs: number; message: string } {
  state.retryCount++
  state.lastError = error
  state.lastCategory = classifyError(error)
  state.backoffMs = getBackoffMs(state.retryCount - 1)

  const action = determineAction(state.lastCategory, state)

  const messages: Record<RecoveryAction, string> = {
    retry: `重试 (第${state.retryCount}次)`,
    retry_backoff: `等待 ${(state.backoffMs / 1000).toFixed(1)}s 后重试 (第${state.retryCount}次)`,
    compact_retry: "压缩上下文后重试",
    fallback: "切换到备用 Provider",
    abort: `放弃: ${error.slice(0, 100)}`,
  }

  return { action, delayMs: state.backoffMs, message: messages[action] }
}
