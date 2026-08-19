import { estimateTokens } from "../shared/message-utils"
import type { LLMMessage } from "../llm/client"

const DOOM_LOOP_THRESHOLD = 3
const DOOM_LOOP_SAME_TOOL_THRESHOLD = 4
const READ_TOOLS = new Set(["read_file", "list_files", "grep", "glob", "web_search", "web_fetch"])
const WRITE_TOOLS = new Set(["write_file", "edit_file", "bash"])

export interface ToolCallRecord {
  name: string
  args: string
}

/**
 * Doom loop 检测 — 三种模式：
 * 1. 精确重复：相同工具+相同参数连续 N 次
 * 2. 同工具风暴：同一工具连续 N+ 次（参数不同）
 * 3. 读-写空转：read→write→read→write 循环超过 2 次
 */
export function detectDoomLoop(
  currentCall: ToolCallRecord,
  recentCalls: ToolCallRecord[],
): boolean {
  // 模式 1: 精确重复检测（原有逻辑增强）
  const lastThree = recentCalls.slice(-DOOM_LOOP_THRESHOLD)
  if (lastThree.length === DOOM_LOOP_THRESHOLD &&
    lastThree.every((tc) => tc.name === currentCall.name && tc.args === currentCall.args)) {
    return true
  }

  // 模式 2: 同工具连续调用风暴
  const recentWithCurrent = [...recentCalls, currentCall]
  const sameToolCount = countConsecutiveSameTool(recentWithCurrent, currentCall.name)
  if (sameToolCount >= DOOM_LOOP_SAME_TOOL_THRESHOLD) return true

  // 模式 3: read→write 空转循环
  const lastSix = recentWithCurrent.slice(-6)
  if (lastSix.length >= 4) {
    let readWriteCycles = 0
    for (let i = 0; i < lastSix.length - 1; i += 2) {
      if (i + 1 < lastSix.length &&
        READ_TOOLS.has(lastSix[i].name) &&
        WRITE_TOOLS.has(lastSix[i + 1].name)) {
        readWriteCycles++
      }
    }
    if (readWriteCycles >= 2) return true
  }

  return false
}

function countConsecutiveSameTool(calls: ToolCallRecord[], toolName: string): number {
  let count = 0
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].name === toolName) count++
    else break
  }
  return count
}

export function detectTextNgramRepeat(text: string, windowSize = 3): boolean {
  if (text.length < windowSize * 3) return false
  const ngrams = new Set<string>()
  let repeats = 0
  for (let i = 0; i <= text.length - windowSize; i++) {
    const ngram = text.slice(i, i + windowSize)
    if (ngrams.has(ngram)) {
      repeats++
      if (repeats >= 5) return true
    }
    ngrams.add(ngram)
  }
  return false
}

export function checkOverflow(
  messages: LLMMessage[],
  maxTokens: number,
  threshold = 0.8,
): boolean {
  return estimateTokens(messages) > maxTokens * threshold
}

