import { z } from "zod"
import { MiraError } from "../../shared/errors"
import type { MiraErrorCode } from "../../shared/errors"

/**
 * LLM 层错误 — 继承统一 MiraError 分类
 * 保持旧代码（code 字符串 + statusCode + provider）向后兼容
 */
export class LLMError extends MiraError {
  constructor(
    message: string,
    code: string,
    public readonly statusCode?: number,
    public readonly provider?: string,
  ) {
    super(message, { code: mapCode(code), context: provider ? { provider } : undefined })
    this.name = "LLMError"
  }

  static provider(provider: string, message: string, statusCode?: number): LLMError {
    return new LLMError(message, "PROVIDER_ERROR", statusCode, provider)
  }

  static auth(provider: string): LLMError {
    return new LLMError(`Authentication failed for ${provider}`, "AUTH_ERROR", 401, provider)
  }

  static rateLimit(provider: string, retryAfter?: number): LLMError {
    return new LLMError(`Rate limited by ${provider}`, "RATE_LIMIT", 429, provider)
  }

  static timeout(provider: string): LLMError {
    return new LLMError(`Request timed out for ${provider}`, "TIMEOUT", undefined, provider)
  }

  static invalidRequest(message: string): LLMError {
    return new LLMError(message, "INVALID_REQUEST")
  }
}

/** 将旧版 LLM 错误码映射到统一分类 */
function mapCode(code: string): MiraErrorCode {
  switch (code) {
    case "AUTH_ERROR": return "AUTHENTICATION"
    case "RATE_LIMIT": return "RATE_LIMIT"
    case "TIMEOUT": return "TIMEOUT"
    case "PROVIDER_ERROR": return "PROVIDER_INTERNAL"
    case "INVALID_REQUEST": return "INVALID_REQUEST"
    default: return "INTERNAL"
  }
}
