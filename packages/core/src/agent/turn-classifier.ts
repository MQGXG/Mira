import type { LLMMessage } from "../llm/client"
import { detectTextNgramRepeat } from "./utils"

/**
 * ── 终止原因（Terminal）──
 * 循环的最终退出原因。对应 Claude Code 的 Terminal 类型。
 * 当 classifyStep 返回此类型，内层循环 break 并以该原因结束。
 */
export type TerminalReason =
  | { type: "completed" }               // 正常完成，模型给出最终回复
  | { type: "filtered"; reason: string } // 内容被安全过滤器拦截
  | { type: "failed"; error: string }   // 模型报错
  | { type: "max-turns" }               // 步数上限

/**
 * ── 继续动作（Continue）──
 * 下一步该怎么继续。对应 Claude Code 的 Continue 类型。
 * 每个变体包含如何修正的指令，循环根据指令注入 nudge 后重试。
 */
export type ContinueAction =
  | { type: "retry"; nudge: string }                          // 无效输出，注入 nudge 后重试
  | { type: "text-repeat"; level: 1 | 2 | 3; nudge: string } // 文本重复，3 级逐步升级
  | { type: "auto-continue"; reason: "length" | "too-short"; nudge: string } // 自动续跑
  | { type: "tool-suggest"; toolName?: string; reason: string; nudge: string } // 建议 LLM 使用工具
  | { type: "continue" }                                      // 正常继续（有工具调用）

/** 分类器的返回类型：要么终止，要么继续 */
export type StepDecision = TerminalReason | ContinueAction

export const MAX_STEPS_WARNING = `⚠️ 这是你的最后一轮回答。

请在本次回复中完成以下工作：
1. 总结已经完成的工作和进展
2. 列出未完成或遗留的事项
3. 给出后续建议或下一步方向

注意：本次过后工具将不可用，请直接回复文本。`

export const MAX_STEPS_REACHED = `CRITICAL - MAXIMUM STEPS REACHED
The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls in this reply.
2. MUST provide a text response summarizing the work so far.
3. This constraint overrides ALL other instructions.

Your response must include:
- A statement that the maximum steps have been reached
- A summary of what has been accomplished so far
- Any remaining tasks that were not completed
- Recommendations for what should be done next`

/** 判断是否为终止原因 */
export function isTerminal(action: StepDecision): action is TerminalReason {
  return action.type === "completed" || action.type === "filtered" || action.type === "failed" || action.type === "max-turns"
}

/** 判断是否为恢复动作（需要注入 nudge 后继续） */
export function isRecovery(action: StepDecision): action is ContinueAction & { nudge: string } {
  return action.type === "retry" || action.type === "text-repeat" || action.type === "auto-continue" || action.type === "tool-suggest"
}

/** 判断是否为正常继续 */
export function isPlainContinue(action: StepDecision): action is ContinueAction & { type: "continue" } {
  return action.type === "continue"
}

export interface ClassifyContext {
  step: number
  maxSteps: number
  ngramBuffer: string[]
  activeGoal: any | null
  toolErrorCount: number
  toolCallCount: number
  userIntent?: "requires_tool" | "chat_only"
}

interface AssistantInfo {
  text: string
  textLength: number
  hasToolCalls: boolean
  isThinkOnly: boolean
  hasError: boolean
  hasFiltered: boolean
  finishReason?: string
}

function getLastAssistant(messages: LLMMessage[]): AssistantInfo {
  let text = ""
  let hasToolCalls = false
  let hasError = false
  let hasFiltered = false
  let finishReason: string | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== "assistant") continue

    const content = m.content
    if (typeof content === "string") {
      text = content
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") text += part.text
        if (part.type === "tool-call") hasToolCalls = true
      }
    }
    hasError = !!(m as any).error
    hasFiltered = (m as any).finish === "content-filter"
    finishReason = (m as any).finish
    break
  }

  return {
    text,
    textLength: text.length,
    hasToolCalls,
    isThinkOnly: !hasToolCalls && text.length === 0,
    hasError,
    hasFiltered,
    finishReason,
  }
}

const REFUSAL_PATTERNS = [
  /不.*需要.*(调用|使用).*工具/i,
  /no tools? (needed|required)/i,
  /this (doesn't|does not) require (any )?tools/i,
  /i (don't|do not) need (to use|any) tools/i,
  /just (回答|reply|tell|explain)/i,
]

function isToolRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some(p => p.test(text))
}

/**
 * 分类检查顺序（优先级从高到低）：
 * 1. max-turns    → Terminal: 步数超限
 * 2. failed       → Terminal: 模型报错
 * 3. filtered     → Terminal: 内容过滤
 * 4. text-repeat  → Continue: N-gram 检测，3 级恢复
 * 5. retry        → Continue: 空输出/纯推理，给一次机会
 * 6. auto-continue→ Continue: finish="length" / 输出太短
 * 7. tool-suggest → Continue: LLM 拒绝调工具但需要工具
 * 8. continue     → Continue: 有工具调用
 * 9. completed    → Terminal: 无工具调用 + 有输出
 */
export function classifyStep(messages: LLMMessage[], ctx: ClassifyContext): StepDecision {
  const assistant = getLastAssistant(messages)

  if (ctx.step >= ctx.maxSteps) return { type: "max-turns" }
  if (assistant.hasError) return { type: "failed", error: "模型上一步出错" }
  if (assistant.hasFiltered) return { type: "filtered", reason: "内容过滤器触发" }

  if (assistant.textLength > 0 && ctx.ngramBuffer.length >= 3) {
    const recentText = ctx.ngramBuffer.slice(-3).join("")
    if (detectTextNgramRepeat(recentText)) {
      return { type: "text-repeat", level: 1, nudge: "检测到重复输出，请换一种方式回答，不要重复之前的内容" }
    }
  }

  if (assistant.isThinkOnly) {
    return { type: "retry", nudge: "请输出实际内容，不要只输出推理过程" }
  }

  if (assistant.finishReason === "length") {
    return { type: "auto-continue", reason: "length", nudge: "上一步输出被截断，请从断点处继续，不要重复已输出的内容" }
  }

  if (!assistant.hasToolCalls) {
    if (assistant.textLength > 0 && isToolRefusal(assistant.text) && ctx.userIntent === "requires_tool") {
      return { type: "tool-suggest", reason: "refusal", nudge: "当前任务可能需要使用工具来完成，请考虑使用合适的工具。" }
    }
    // 极短回答（<20 字符）且上一步有工具调用 → 模型可能只回了"完成。"，补一句总结提示
    // 但纯聊天（无工具历史）的简短回答（如"4"、"是的"）不应被强制续写
    if (assistant.textLength < 20 && ctx.toolCallCount > 0) {
      return { type: "auto-continue", reason: "too-short", nudge: "请基于工具结果给出完整总结回答" }
    }
    return { type: "completed" }
  }

  if (ctx.toolErrorCount > 0 && ctx.toolErrorCount >= ctx.toolCallCount / 2) {
    return { type: "continue" }
  }

  return { type: "continue" }
}
