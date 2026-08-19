import type { LLMMessage } from '../llm/client'

interface AnyContentPart {
  type: string
  text?: string
}

function contentLength(content: string | Array<AnyContentPart>): number {
  if (typeof content === 'string') return content.length
  return content.reduce((sum, p) => sum + (p.text?.length || JSON.stringify(p).length), 0)
}

/**
 * 估算单段文本的 token 数（语言感知，参考 DeepSeek 官方换算比）
 * - 英文字符 ≈ 0.3 token/字符（约 3.3 字符/token）
 * - 中文字符 ≈ 0.6 token/字符（约 1.67 字符/token，比英文贵约 2 倍）
 * 快速检测：统计 CJK 字符比例，中文字符按 0.6、其余按 0.3 估算。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjkChars = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // CJK 统一表意文字（U+4E00–U+9FFF）及扩展区
    if (code >= 0x4E00 && code <= 0x9FFF) cjkChars++
  }
  const nonCjk = text.length - cjkChars
  return Math.max(1, Math.round(cjkChars * 0.6 + nonCjk * 0.3))
}

export function hasToolCalls(content: string | Array<AnyContentPart>): boolean {
  if (typeof content === 'string') return false
  return content.some(p => p.type === 'tool-call')
}

export function repairMessageSequence(messages: LLMMessage[]): LLMMessage[] {
  const repaired: LLMMessage[] = []
  // 已由前置 assistant 声明的 tool_call_id 集合 — 用于识别孤立 tool 消息
  const declaredToolCallIds = new Set<string>()

  const collectDeclaredIds = (content: string | Array<AnyContentPart>): string[] => {
    if (typeof content === 'string') return []
    return content.filter((p) => p.type === 'tool-call').map((p) => (p as any).toolCallId).filter(Boolean)
  }
  const getToolResultId = (content: string | Array<AnyContentPart>, tool_call_id?: string): string | undefined => {
    if (tool_call_id) return tool_call_id
    if (Array.isArray(content)) {
      const tr = content.find((p) => p.type === 'tool-result') as any
      return tr?.toolCallId
    }
    return undefined
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const id of collectDeclaredIds(msg.content)) declaredToolCallIds.add(id)
    }
    const last = repaired[repaired.length - 1]
    // 孤立 tool 消息：tool_call_id 未被任何前置 assistant 声明 → 转为文本附加到上一条消息，避免 API 400 且不丢数据
    if (msg.role === 'tool') {
      const toolId = getToolResultId(msg.content, msg.tool_call_id)
      if (toolId && !declaredToolCallIds.has(toolId)) {
        const output = Array.isArray(msg.content)
          ? ((msg.content.find((p) => p.type === 'tool-result') as any)?.output || '')
          : msg.content
        const text = `[孤立工具结果: ${String(output).slice(0, 500)}]`
        if (last && typeof last.content === 'string') {
          last.content += '\n\n' + text
          continue
        }
        repaired.push({ role: 'assistant', content: text })
        continue
      }
    }
    if (last?.role === 'tool' && msg.role !== 'assistant' && msg.role !== 'tool') {
      // 上一条是 tool 结果，当前不是 assistant 也不是 tool → 补一个 assistant 占位
      repaired.push({ role: 'assistant', content: [] })
    }
    // 连续 tool 消息（同回合多工具结果）：允许紧跟，不补 assistant——前提是它们都有对应的声明
    if (last?.role === 'tool' && msg.role === 'tool') {
      const lastToolId = getToolResultId(last.content, last.tool_call_id)
      const curToolId = getToolResultId(msg.content, msg.tool_call_id)
      // 当前 tool 若无声明（孤立）→ 转文本；有声明则直接保留
      if (curToolId && !declaredToolCallIds.has(curToolId)) {
        const output = Array.isArray(msg.content)
          ? ((msg.content.find((p) => p.type === 'tool-result') as any)?.output || '')
          : msg.content
        const text = `[孤立工具结果: ${String(output).slice(0, 500)}]`
        if (typeof last.content === 'string') {
          last.content += '\n\n' + text
        } else {
          repaired.push({ role: 'assistant', content: text })
        }
        continue
      }
      // 保留当前 tool（两个 tool 都合法，OpenAI 允许 assistant(tool_calls) 后多条 tool）
      repaired.push(msg)
      continue
    }
    if (last?.role === 'user' && msg.role === 'user') {
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += '\n\n' + msg.content
      }
      continue
    }
    if (last?.role === 'assistant' && msg.role === 'assistant' && !hasToolCalls(last.content)) {
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += '\n\n' + msg.content
      }
      continue
    }
    repaired.push(msg)
  }
  if (repaired[repaired.length - 1]?.role === 'tool') {
    repaired.push({ role: 'assistant', content: [] })
  }
  return repaired
}

/**
 * 发送给 LLM 前的消息清洗（参考 OpenCode/MiMo-Code 的发送前防线）
 *
 * 确保每个 assistant 的 tool-call 都有对应的 tool 结果，杜绝"孤立 tool_use"导致 HTTP 400。
 * 重建策略：按 "assistant(tool-call) → 该 assistant 声明的全部结果" 分组，严格保证顺序。
 * 原始序列中游离的 tool 结果会与对应 assistant 重新配对，孤儿 tool 结果（无对应 call）被移除。
 */
export function sanitizeMessagesForLLM(messages: LLMMessage[]): LLMMessage[] {
  // 收集所有 assistant 声明的 tool_call_id
  const declaredToolCallIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue
    for (const part of msg.content) {
      if (part.type === 'tool-call' && part.toolCallId) declaredToolCallIds.add(part.toolCallId)
    }
  }
  // 收集 tool 结果：按 tool_call_id 建 map（content 字符串或 tool-result part）
  const resultMap = new Map<string, string>()
  const resultToolName = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'tool') continue
    const id = msg.tool_call_id
    if (id && !resultMap.has(id)) {
      if (Array.isArray(msg.content)) {
        const tr = msg.content.find(p => p.type === 'tool-result') as any
        if (tr) {
          resultMap.set(id, typeof tr.output === 'string' ? tr.output : tr.output?.value ?? '')
          resultToolName.set(id, tr.toolName || '')
        }
      } else if (typeof msg.content === 'string') {
        resultMap.set(id, msg.content)
      }
      continue
    }
    // 无 tool_call_id → 尝试从 part 提取
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'tool-result' && part.toolCallId && !resultMap.has(part.toolCallId)) {
          resultMap.set(part.toolCallId, typeof part.output === 'string' ? part.output : (part.output as any)?.value ?? '')
          resultToolName.set(part.toolCallId, part.toolName || '')
        }
      }
    }
  }

  const result: LLMMessage[] = []
  for (const msg of messages) {
    // tool 消息不直接追加——由 assistant 分组统一输出（避免顺序交错）
    if (msg.role === 'tool') continue
    result.push(msg)
    // 对每条 assistant(tool-call)，紧跟输出其声明的所有结果（缺失补 error）
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type !== 'tool-call' || !part.toolCallId) continue
        const id = part.toolCallId
        const output = resultMap.has(id) ? resultMap.get(id)! : '[Tool execution was interrupted]'
        result.push({
          role: 'tool',
          content: [{ type: 'tool-result', toolCallId: id, toolName: part.toolName, output }],
          tool_call_id: id,
        })
      }
    }
  }

  const repaired = repairMessageSequence(result)
  return ensureTrailingUserMessage(repaired)
}

/**
 * 发送前不变式：消息必须以 user 结尾（参考 MiMo-Code ensureTrailingUserMessage）。
 * 部分 provider（如 Bedrock Converse）硬拒绝以 assistant 结尾的对话（prefill 400）。
 * - 尾部空 assistant 残留 → 丢弃
 * - 尾部有内容的 assistant（已完成的回答）→ 保留 + 追加最小 user 回合，不删除内容
 */
export function ensureTrailingUserMessage(messages: LLMMessage[]): LLMMessage[] {
  if (messages.length === 0) return messages

  // 丢弃尾部"纯空 assistant 残留"（无文本、无 tool-call、无 reasoning）
  let end = messages.length
  while (end > 0) {
    const m = messages[end - 1]
    if (m.role !== 'assistant') break
    const content = m.content
    const hasContent = typeof content === 'string'
      ? content.trim().length > 0 || !!m.reasoning_content
      : content.some(p => (p.type === 'text' && p.text) || p.type === 'tool-call' || p.type === 'reasoning')
    if (!hasContent) { end--; continue }
    break
  }

  const trimmed = messages.slice(0, end)
  if (trimmed.length === 0) return trimmed
  const last = trimmed[trimmed.length - 1]
  if (last.role === 'user') return trimmed

  // 尾部是 assistant（有内容）或 tool（未总结）：追加最小 user 回合，避免 prefill 400
  return [...trimmed, { role: 'user', content: 'Continue.' }]
}

export function estimateTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => {
    // 语言感知估算消息内容（中文 0.6/字，英文 0.3/字）
    const content = m.content
    let textTokens = 0
    if (typeof content === 'string') {
      textTokens = estimateTextTokens(content)
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (p.type === 'text') textTokens += estimateTextTokens(p.text || '')
        else if (p.type === 'reasoning') textTokens += estimateTextTokens(p.text || '')
        else if (p.type === 'tool-result') {
          const out = typeof p.output === 'string' ? p.output : (p.output as any)?.value ?? ''
          textTokens += estimateTextTokens(out)
        }
      }
    }
    return sum + textTokens
  }, 0)
}
export function truncateToBudget(messages: LLMMessage[], maxTokens: number): LLMMessage[] {
  if (estimateTokens(messages) <= maxTokens) return messages
  const system = messages.find(m => m.role === 'system')
  const rest = messages.filter(m => m.role !== 'system')

  // 目标：压缩到 70% 的 budget，留出空间
  const targetTokens = Math.floor(maxTokens * 0.7)

  while (rest.length > 2 && estimateTokens([system!, ...rest]) > targetTokens) {
    const removed = rest.shift()!
    // 如果移除的是带 tool-call 的 assistant，连带后面的 tool 消息一起移除
    if (removed.role === 'assistant' && hasToolCalls(removed.content)) {
      while (rest.length > 0 && rest[0].role === 'tool') {
        rest.shift()
      }
    }
    // 如果移除后队首是 tool 消息（孤立的结果），也一并移除
    while (rest.length > 0 && rest[0].role === 'tool') {
      rest.shift()
    }
  }
  const result = system ? [system, ...rest] : rest
  return ensureTrailingUserMessage(repairMessageSequence(result))
}

/**
 * 上下文重建 — 当接近 token 限制时，从 checkpoint 重建上下文
 * 参考 MiMo-Code 的 context reconstruction 系统
 */
export interface CheckpointData {
  summary: string
  activeTask: string
  recentDecisions: string[]
  keyFiles: string[]
  userPreferences?: string[]
  intent?: string
  taskTree?: string[]
  currentWork?: string
  findings?: string[]
  errorFixes?: string[]
  designDecisions?: string[]
}

export function rebuildContextFromCheckpoint(
  messages: LLMMessage[],
  checkpoint: CheckpointData,
  maxTokens: number,
): LLMMessage[] {
  const system = messages.find(m => m.role === 'system')
  const rest = messages.filter(m => m.role !== 'system')

  // 构建 checkpoint 上下文摘要
  const checkpointParts: string[] = []
  if (checkpoint.summary) {
    checkpointParts.push(`[Session Summary]\n${checkpoint.summary}`)
  }
  if (checkpoint.activeTask) {
    checkpointParts.push(`[Active Task]\n${checkpoint.activeTask}`)
  }
  if (checkpoint.recentDecisions.length > 0) {
    const recent = checkpoint.recentDecisions.slice(-5)
    checkpointParts.push(`[Recent Decisions]\n${recent.map(d => `- ${d}`).join('\n')}`)
  }
  if (checkpoint.keyFiles.length > 0) {
    const recentFiles = checkpoint.keyFiles.slice(-10)
    checkpointParts.push(`[Key Files]\n${recentFiles.map(f => `- ${f}`).join('\n')}`)
  }

  // 保留最近的消息（约 20% 的 budget，更激进的压缩）
  const recentBudget = Math.floor(maxTokens * 0.2)
  const keptMessages: LLMMessage[] = []
  let tokenCount = 0

  // 从后往前保留消息
  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i]
    const msgTokens = Math.ceil(contentLength(msg.content) / 4) + 50
    if (tokenCount + msgTokens > recentBudget) break
    keptMessages.unshift(msg)
    tokenCount += msgTokens
  }

  // 构建重建后的消息
  const checkpointSummary = checkpointParts.length > 0
    ? `[Context Reconstruction: Earlier conversation was truncated. Here's what was discussed before]\n\n${checkpointParts.join('\n\n')}`
    : ''

  const systemContent = typeof system?.content === 'string' ? system.content : ''
  const newSystem = system
    ? { ...system, content: systemContent + (checkpointSummary ? `\n\n${checkpointSummary}` : '') }
    : null

  const result = newSystem ? [newSystem, ...keptMessages] : keptMessages
  return repairMessageSequence(result)
}

/**
 * 检查是否需要上下文重建
 * 在 60% 时就开始重建，避免接近限制时才处理
 */
export function needsContextRebuild(messages: LLMMessage[], maxTokens: number): boolean {
  const currentTokens = estimateTokens(messages)
  return currentTokens > maxTokens * 0.6
}

