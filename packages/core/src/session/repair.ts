/**
 * 中断修复 — 为被中断的会话日志补齐未闭合的工具结果（对齐 dsh repair 语义简化移植）
 *
 * 崩溃恢复：保留已完整写入的最后一轮，为缺失的工具结果/边界补合成事件，
 * 使恢复时提供 provider 可接受的转录。
 *
 * Mira 模型：Mira 用 message.appended 追加字符串 content 消息（role 含 tool），
 * 无 dsh 的 turn/step/tool-call 结构化块。故本实现以「识别未闭合的 tool 消息
 * （已追加 assistant 含工具调用但缺对应 tool 结果）」为主 —— 在 Mira 模型中
 * tool 结果消息本身即 `role: "tool"` 的 message.appended。修复为追加错误结果消息。
 */

import type { SessionEvent } from "./event-types"
import { createMessageEvent } from "./event-types"

/** 工具调用在记录为已开始前被中断 */
export const TOOL_NOT_STARTED = "TOOL_NOT_STARTED"

/** 已记录的工具调用其完成结果未持久化 */
export const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN"

/**
 * 返回确定性合成事件以闭合一个打开的尾部回合。
 * 未匹配的工具调用先收到错误结果，随后补 turn/end；日志已平衡或为空则不返回。
 * seq 延续日志，时间戳沿用最后真实事件。
 *
 * 注意：Mira 的 message.appended 是扁平字符串模型，无法可靠复原"未闭合的工具调用"
 * 结构（无独立 tool-call 事件）。本实现保守地扫描日志：
 *  - 若最后是 `role: "assistant"` 且 content 含 `"tool-call"` 标记（JSON），
 *    判定该回合可能中断，追加 TOOL_OUTCOME_UNKNOWN 错误结果。
 *  - 其余情况视为平衡（无可合成结果）。
 *
 * @param events - 已加载的持久日志（有效已提交前缀，可能含崩溃尾）。
 * @returns 应追加在 events 后的合成事件，日志已平衡时为空。
 */
export function interruptedTurnClosers(events: readonly SessionEvent[]): SessionEvent[] {
  const last = events.at(-1)
  if (last === undefined) return []
  if (last.type !== "message.appended") return []
  if (last.payload.role !== "assistant") return []
  if (!last.payload.content.includes("tool-call")) return []

  // 末条是含工具调用的 assistant 消息，但缺对应 tool 结果 → 追加未知结果
  const closers: SessionEvent[] = []
  const time = last.timestamp
  const seq = last.seq + 1
  const e1: SessionEvent = {
    ...createMessageEvent(
      last.session_id,
      {
        role: "tool",
        content: JSON.stringify({
          isError: true,
          error: {
            name: "ToolOutcomeUnknownError",
            code: TOOL_OUTCOME_UNKNOWN,
            message: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.",
          },
        }),
        retryCount: 0,
      },
      time,
    ),
    seq,
  }
  closers.push(e1)
  // 补闭合边界：追加一条 assistant 总结提示（Mira 无 turn/end，用消息标记回合结束）
  const e2: SessionEvent = {
    ...createMessageEvent(
      last.session_id,
      { role: "assistant", content: "[回合因中断而结束，请从以上信息继续]", retryCount: 0 },
      time,
    ),
    seq: seq + 1,
  }
  closers.push(e2)
  return closers
}

/**
 * 判断工具结果消息是否表达"未开始"或"结果未知"的中断错误。
 * @param content - tool 消息的 content 字符串（JSON 解析）。
 * @returns 中断错误码，或 undefined。
 */
export function toolInterruptionCode(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { error?: { code?: string } }
    if (parsed.error?.code === TOOL_OUTCOME_UNKNOWN) return TOOL_OUTCOME_UNKNOWN
    if (parsed.error?.code === TOOL_NOT_STARTED) return TOOL_NOT_STARTED
  } catch { /* 非 JSON 忽略 */ }
  return undefined
}
