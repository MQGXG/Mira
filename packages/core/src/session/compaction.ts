/**
 * 多层 Compaction — 参考 learn-claude-code 的 4 层压缩策略
 * L1: snip_compact - 裁剪中间消息
 * L2: micro_compact - 替换旧工具结果
 * L3: tool_result_budget - 大结果持久化到磁盘
 * L4: compact_history - LLM 摘要压缩
 */

import { getToolResultOutput, type ToolResultOutput } from "../llm/schema/messages"
import { estimateTextBlock, estimateContentBlocks } from "../shared/token-meter"
import { nearestBalancedCut, nextBalancedCut } from "./tool-pairing"

export type CompactLevel = "none" | "l1_snip" | "l2_micro" | "l3_auto"

type ContentPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; image: string; mediaType?: string }
  | { type: "tool-result"; output: ToolResultOutput }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }

interface Message {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentPart[]
  tool_call_id?: string
  reasoning_content?: string
}

interface CompactionConfig {
  maxTokens: number
  keepRecentCount: number
  toolResultMaxChars: number
  snipThreshold: number
  microThreshold: number
}

interface CompactResult {
  messages: Message[]
  level: CompactLevel
}

const DEFAULT_CONFIG: CompactionConfig = {
  maxTokens: 8000,
  keepRecentCount: 4,
  toolResultMaxChars: 2000,
  snipThreshold: 20,
  microThreshold: 10,
}

// 估算 token 数（固定密度 + 结构感知，与 token-meter 一致）
function estimateTokens(text: string): number {
  return estimateTextBlock(text)
}

function getMessageTokens(msg: Message): number {
  if (typeof msg.content === "string") {
    return estimateTokens(msg.content)
  }
  if (Array.isArray(msg.content)) {
    return estimateContentBlocks(msg.content)
  }
  return 0
}

/**
 * L1: Snip Compact - 裁剪中间消息
 * 保留头部和尾部，裁剪中间部分。
 * 头/尾切口会调整到工具配对平衡边界，避免切断 tool-call/result 对。
 */
function snipCompact(messages: Message[], config: CompactionConfig): Message[] {
  if (messages.length <= config.snipThreshold) {
    return messages
  }

  const headCount = 3
  const tailCount = config.keepRecentCount
  const len = messages.length

  // 头切口：从 headCount 向后找最近的平衡切口（确保 head 内 tool-call 配对完整）
  const headCut = nextBalancedCut(messages, headCount, len - tailCount)
  if (headCut < 0) return messages
  // 尾切口：从 len - tailCount 向前找最近的平衡切口（确保 tail 内配对完整）
  const tailCut = nearestBalancedCut(messages, len - tailCount, headCut + 1)
  if (tailCut < 0) return messages

  const head = messages.slice(0, headCut)
  const middle = messages.slice(headCut, tailCut)
  const tail = messages.slice(tailCut)

  // 用摘要替代中间消息
  const summary: Message = {
    role: "assistant",
    content: `[Earlier ${middle.length} messages compacted. Key points: ${extractKeyPoints(middle)}]`,
  }

  return [...head, summary, ...tail]
}

/**
 * L2: Micro Compact - 替换旧工具结果
 * 将旧的工具调用结果替换为占位符
 */
function microCompact(messages: Message[], config: CompactionConfig): Message[] {
  const cutoff = messages.length - config.keepRecentCount * 2

  return messages.map((msg, idx) => {
    if (idx >= cutoff) return msg // 保留最近的消息

    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg.content.length > config.toolResultMaxChars) {
        return {
          ...msg,
          content: `[Earlier tool result compacted. Length: ${msg.content.length} chars]`,
        }
      }
    }

    if (Array.isArray(msg.content)) {
      const hasLargeResult = msg.content.some(
        part => part.type === "tool-result" && getToolResultOutput(part.output).length > config.toolResultMaxChars
      )
      if (hasLargeResult) {
        return {
          ...msg,
          content: msg.content.map(part => {
            if (part.type === "tool-result" && getToolResultOutput(part.output).length > config.toolResultMaxChars) {
              return { ...part, output: `[Earlier tool result compacted. Length: ${getToolResultOutput(part.output).length} chars]` }
            }
            return part
          }),
        }
      }
    }

    return msg
  })
}

/**
 * L3: Tool Result Budget - 大结果持久化
 * 将大结果截断到预算内
 */
function toolResultBudget(messages: Message[], maxChars: number): Message[] {
  return messages.map(msg => {
    if (msg.role === "tool" && typeof msg.content === "string") {
      if (msg.content.length > maxChars) {
        return {
          ...msg,
          content: msg.content.slice(0, maxChars) + `\n... [truncated, ${msg.content.length} chars total]`,
        }
      }
    }

    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(part => {
          if (part.type === "tool-result" && getToolResultOutput(part.output).length > maxChars) {
            return { ...part, output: getToolResultOutput(part.output).slice(0, maxChars) + `\n... [truncated]` }
          }
          return part
        }),
      }
    }

    return msg
  })
}

/**
 * L4: Compact History - 生成摘要
 * 使用 LLM 生成对话摘要（异步）
 */
async function compactHistory(
  messages: Message[],
  llmCall?: (prompt: string) => Promise<string>
): Promise<Message[]> {
  if (!llmCall) {
    // 无 LLM 时使用简单摘要
    const summary = generateSimpleSummary(messages)
    return [
      { role: "assistant", content: `[Conversation summary: ${summary}]` },
      ...messages.slice(-4),
    ]
  }

  // 使用 LLM 生成摘要
  const conversationText = messages.map(m => {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    return `${m.role}: ${content.slice(0, 500)}`
  }).join("\n")

  const prompt = `Summarize this conversation in 2-3 sentences, focusing on key decisions and progress:\n\n${conversationText}`

  try {
    const summary = await llmCall(prompt)
    return [
      { role: "assistant", content: `[Conversation summary: ${summary}]` },
      ...messages.slice(-4),
    ]
  } catch {
    // LLM 调用失败，使用简单摘要
    const summary = generateSimpleSummary(messages)
    return [
      { role: "assistant", content: `[Conversation summary: ${summary}]` },
      ...messages.slice(-4),
    ]
  }
}

/**
 * 生成简单摘要
 */
function generateSimpleSummary(messages: Message[]): string {
  const userMessages = messages.filter(m => m.role === "user")
  const assistantMessages = messages.filter(m => m.role === "assistant")

  const topics = userMessages.slice(-3).map(m => {
    const content = typeof m.content === "string" ? m.content : ""
    return content.slice(0, 100)
  }).join("; ")

  return `Discussion about: ${topics || "various topics"}. ${assistantMessages.length} assistant responses.`
}

/**
 * 提取关键点
 */
function extractKeyPoints(messages: Message[]): string {
  const points: string[] = []

  for (const msg of messages.slice(-5)) {
    const content = typeof msg.content === "string" ? msg.content : ""
    if (content.length > 50) {
      points.push(content.slice(0, 80))
    }
  }

  return points.join("; ") || "various topics discussed"
}

/**
 * 渐进式压缩 — 旧接口兼容版
 * 根据上下文压力选择合适的压缩层级
 * 压缩后校验确实变小（摘要 token 数必须小于被覆盖内容），否则返回原样。
 */
export function compactMessages(
  messages: Message[],
  maxTokens: number,
  level: CompactLevel = "none"
): CompactResult {
  const totalTokens = messages.reduce((sum, m) => sum + getMessageTokens(m), 0)

  // 根据压力选择压缩策略
  if (totalTokens <= maxTokens) {
    return { messages, level: "none" }
  }

  let result = [...messages]
  let appliedLevel: CompactLevel = "none"

  // L1: 裁剪中间消息
  if (level === "l1_snip" || level === "l2_micro" || level === "l3_auto") {
    result = snipCompact(result, { maxTokens, keepRecentCount: 4, toolResultMaxChars: 2000, snipThreshold: 20, microThreshold: 10 })
    appliedLevel = "l1_snip"
  }

  // L2: 替换旧工具结果
  if (level === "l2_micro" || level === "l3_auto") {
    result = microCompact(result, { maxTokens, keepRecentCount: 4, toolResultMaxChars: 2000, snipThreshold: 20, microThreshold: 10 })
    appliedLevel = "l2_micro"
  }

  // L3: 截断大结果
  if (level === "l3_auto") {
    result = toolResultBudget(result, 2000)
    appliedLevel = "l3_auto"
  }

  // 收益校验：压缩后必须比原样更小，否则放弃本次压缩
  const afterTokens = result.reduce((sum, m) => sum + getMessageTokens(m), 0)
  if (afterTokens >= totalTokens) {
    return { messages, level: "none" }
  }

  return { messages: result, level: appliedLevel }
}

/**
 * 渐进式压缩 — 新接口版
 * 根据上下文压力选择合适的压缩层级
 */
export async function compactMessagesAsync(
  messages: Message[],
  config: Partial<CompactionConfig> = {},
  llmCall?: (prompt: string) => Promise<string>
): Promise<Message[]> {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const totalTokens = messages.reduce((sum, m) => sum + getMessageTokens(m), 0)

  // 根据压力选择压缩策略
  if (totalTokens < fullConfig.maxTokens * 0.7) {
    return messages // 压力不大，不压缩
  }

  let result = [...messages]

  // L1: 裁剪中间消息
  if (result.length > fullConfig.snipThreshold) {
    result = snipCompact(result, fullConfig)
  }

  // L2: 替换旧工具结果
  if (result.length > fullConfig.microThreshold) {
    result = microCompact(result, fullConfig)
  }

  // L3: 截断大结果
  result = toolResultBudget(result, fullConfig.toolResultMaxChars)

  // L4: 如果仍然超过阈值，使用 LLM 摘要
  const newTokens = result.reduce((sum, m) => sum + getMessageTokens(m), 0)
  if (newTokens > fullConfig.maxTokens * 0.8) {
    result = await compactHistory(result, llmCall)
  }

  // 收益校验：压缩后必须比原样更小，否则放弃本次压缩
  const afterTokens = result.reduce((sum, m) => sum + getMessageTokens(m), 0)
  if (afterTokens >= totalTokens) {
    return messages
  }

  return result
}
