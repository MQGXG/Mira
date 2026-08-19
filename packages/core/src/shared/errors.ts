/**
 * 统一错误分类体系 — 参考 OpenCode Tagged Error Union
 *
 * 所有领域错误继承 MiraError，携带结构化 code 以便调用方精确处理：
 * - 重试策略（RateLimit/Transport/ProviderInternal 自动重试）
 * - 用户提示（Authentication/QuotaExceeded/ContentPolicy 需人工干预）
 * - 日志分组（按 code 过滤）
 */

export type MiraErrorCode =
  // 请求层
  | "INVALID_REQUEST"
  | "AUTHENTICATION"
  | "RATE_LIMIT"
  | "QUOTA_EXCEEDED"
  | "CONTENT_POLICY"
  | "TIMEOUT"
  | "TRANSPORT"
  | "PROVIDER_INTERNAL"
  // 工具层
  | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION"
  | "TOOL_INVALID_ARGS"
  | "TOOL_OUTPUT_TOO_LARGE"
  // 权限层
  | "PERMISSION_DENIED"
  | "PERMISSION_ASK"
  // 会话/上下文层
  | "SESSION_NOT_FOUND"
  | "CONTEXT_OVERFLOW"
  | "CHECKPOINT_NOT_FOUND"
  // 系统层
  | "DB_ERROR"
  | "FS_ERROR"
  | "NETWORK"
  | "INTERNAL"

export interface MiraErrorOptions {
  code?: MiraErrorCode
  /** 是否可自动重试 */
  retryable?: boolean
  /** 建议的 retry-after 秒数 */
  retryAfterMs?: number
  /** 原始错误（用于日志堆栈） */
  cause?: unknown
  /** 附加上下文（provider、toolName 等） */
  context?: Record<string, unknown>
}

export class MiraError extends Error {
  readonly code: MiraErrorCode
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly cause?: unknown
  readonly context?: Record<string, unknown>

  constructor(message: string, options: MiraErrorOptions = {}) {
    super(message)
    this.name = "MiraError"
    this.code = options.code ?? "INTERNAL"
    this.retryable = options.retryable ?? isDefaultRetryable(this.code)
    this.retryAfterMs = options.retryAfterMs
    this.cause = options.cause
    this.context = options.context
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      context: this.context,
    }
  }
}

function isDefaultRetryable(code: MiraErrorCode): boolean {
  switch (code) {
    case "RATE_LIMIT":
    case "TIMEOUT":
    case "TRANSPORT":
    case "PROVIDER_INTERNAL":
    case "NETWORK":
      return true
    default:
      return false
  }
}

// ── 工厂函数 ────────────────────────────────────────────────

export function invalidRequest(message: string, context?: Record<string, unknown>): MiraError {
  return new MiraError(message, { code: "INVALID_REQUEST", context })
}

export function authError(message: string, context?: Record<string, unknown>): MiraError {
  return new MiraError(message, { code: "AUTHENTICATION", context })
}

export function rateLimitError(message: string, retryAfterMs?: number, context?: Record<string, unknown>): MiraError {
  return new MiraError(message, { code: "RATE_LIMIT", retryable: true, retryAfterMs, context })
}

export function quotaError(message: string, context?: Record<string, unknown>): MiraError {
  return new MiraError(message, { code: "QUOTA_EXCEEDED", context })
}

export function contentPolicyError(message: string, context?: Record<string, unknown>): MiraError {
  return new MiraError(message, { code: "CONTENT_POLICY", context })
}

export function timeoutError(message: string, context?: Record<string, unknown>): MiraError {
  return new MiraError(message, { code: "TIMEOUT", retryable: true, context })
}

export function transportError(message: string, cause?: unknown, context?: Record<string, unknown>): MiraError {
  return new MiraError(message, { code: "TRANSPORT", retryable: true, cause, context })
}

export function providerError(message: string, provider?: string, cause?: unknown): MiraError {
  return new MiraError(message, { code: "PROVIDER_INTERNAL", retryable: true, cause, context: provider ? { provider } : undefined })
}

export function toolNotFoundError(name: string): MiraError {
  return new MiraError(`Tool not found: ${name}`, { code: "TOOL_NOT_FOUND" })
}

export function toolExecutionError(name: string, message: string, cause?: unknown): MiraError {
  return new MiraError(message, { code: "TOOL_EXECUTION", context: { toolName: name }, cause })
}

export function toolInvalidArgsError(name: string, message: string): MiraError {
  return new MiraError(message, { code: "TOOL_INVALID_ARGS", context: { toolName: name } })
}

export function permissionDeniedError(action: string, resource?: string): MiraError {
  return new MiraError(`Permission denied: ${action}${resource ? ` (${resource})` : ""}`, {
    code: "PERMISSION_DENIED",
    context: { action, resource },
  })
}

export function sessionNotFoundError(id: string): MiraError {
  return new MiraError(`Session not found: ${id}`, { code: "SESSION_NOT_FOUND", context: { sessionId: id } })
}

export function contextOverflowError(message: string): MiraError {
  return new MiraError(message, { code: "CONTEXT_OVERFLOW" })
}

export function dbError(message: string, cause?: unknown): MiraError {
  return new MiraError(message, { code: "DB_ERROR", cause })
}

export function fsError(message: string, cause?: unknown): MiraError {
  return new MiraError(message, { code: "FS_ERROR", cause })
}

export function internalError(message: string, cause?: unknown): MiraError {
  return new MiraError(message, { code: "INTERNAL", cause })
}

// ── 类型守卫 ────────────────────────────────────────────────

export function isMiraError(err: unknown): err is MiraError {
  return err instanceof MiraError
}

/** 提取错误码（普通 Error → "INTERNAL"，MiraError → 自身 code） */
export function getErrorCode(err: unknown): MiraErrorCode {
  if (err instanceof MiraError) return err.code
  return "INTERNAL"
}

/** 瞬时可重试的 HTTP 状态码（参考 MiMo-Code retry.ts） */
const RETRYABLE_HTTP_STATUS = new Set([429, 408, 500, 502, 503, 504, 529])
/** 网络层错误码 */
const NETWORK_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND"])

/**
 * 判断错误是否可重试（单一事实源，参考 MiMo-Code isRetryableTransientError）
 * - HTTP 429/408/5xx → 可重试（即使 SDK 标记 isRetryable:false，429/5xx 强制重试）
 * - 网络错误码（ECONNRESET/ETIMEDOUT 等）→ 可重试
 * - MiraError 按其 retryable 标记
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof MiraError) return err.retryable

  // 从 Error 消息 / 结构提取状态码（兼容 status / statusCode / code 字段）
  let status: number | undefined
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>
    const s = obj.status ?? obj.statusCode ?? obj.code
    if (typeof s === "number") status = s
    else if (typeof s === "string") status = parseInt(s, 10)
  }
  if (status !== undefined && !Number.isNaN(status)) {
    if (RETRYABLE_HTTP_STATUS.has(status)) return true
    if (status >= 500) return true
  }

  if (err instanceof Error) {
    // 网络错误码（Node.js errno）
    const code = (err as NodeJS.ErrnoException).code
    if (code && NETWORK_ERROR_CODES.has(code)) return true
    // SSE 读超时 / 请求超时
    const msg = err.message.toLowerCase()
    if (msg.includes("sse read timed out") || msg.includes("request timed out") || msg.includes("socket hang up")) return true
    // 从消息文本提取 HTTP 状态码
    const httpCode = parseInt(err.message.match(/HTTP (\d+)/)?.[1] || "0", 10)
    if (httpCode >= 500) return true
    if (httpCode === 429 || httpCode === 408) return true
  }
  return false
}
