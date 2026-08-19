/**
 * 固定密度 token 估算器 — 参考 DeepSeek Harness token-meter/estimate.ts
 *
 * 按内容块结构递归计价（text/reasoning/tool-call/tool-result 分开），
 * 无外部依赖、跨 provider 一致，用于驱动"压缩收益是否值得"的决策。
 */

import type { LLMMessage } from "../llm/client"

/** 固定文本密度：每 token 4 字符 */
const CHARS_PER_TOKEN = 4

/** 每个内容块的 JSON 框架/类型标签开销 */
const BLOCK_OVERHEAD = 4

/** 每条消息的角色字段框架开销 */
const ROLE_OVERHEAD = 4

/** 工具调用参数 JSON 的附加开销 */
const TOOL_CALL_OVERHEAD = 8

/** 估算单个文本/推理内容块的 token 数 */
export function estimateTextBlock(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** 递归估算内容块数组的 token 数（结构感知） */
export function estimateContentBlocks(blocks: ReadonlyArray<unknown>): number {
  let tokens = 0
  for (const block of blocks) {
    const part = block as {
      type?: string
      text?: string
      toolCallId?: string
      toolName?: string
      args?: unknown
      arguments?: string
      output?: unknown
      image?: string
    }
    switch (part.type) {
      case "text":
      case "reasoning":
        tokens += estimateTextBlock(part.text || "")
        break
      case "tool-call": {
        let argsText = ""
        if (typeof part.arguments === "string") argsText = part.arguments
        else if (part.args !== undefined) argsText = JSON.stringify(part.args) || ""
        tokens += Math.ceil((part.toolName || "").length / CHARS_PER_TOKEN)
          + Math.ceil(argsText.length / CHARS_PER_TOKEN)
          + TOOL_CALL_OVERHEAD
        break
      }
      case "tool-result": {
        const raw = part.output
        const out = typeof raw === "string"
          ? raw
          : (raw as { value?: string } | undefined)?.value ?? JSON.stringify(raw ?? "")
        tokens += estimateTextBlock(out || "") + BLOCK_OVERHEAD
        break
      }
      case "image":
        tokens += BLOCK_OVERHEAD
        break
      default:
        // 未知块（ContentBlock 可扩展）：按结构保守计价
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** 估算一条消息的总 token 数（内容 + 角色框架开销） */
export function estimateMessageTokens(message: LLMMessage): number {
  const content = message.content
  if (typeof content === "string") {
    return estimateTextBlock(content) + ROLE_OVERHEAD
  }
  return estimateContentBlocks(content) + ROLE_OVERHEAD
}

/** 估算消息数组的总 token 数 */
export function estimateMessagesTokens(messages: ReadonlyArray<LLMMessage>): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}
