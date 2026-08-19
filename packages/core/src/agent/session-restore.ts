/**
 * 会话恢复 — 从 DB 恢复历史消息
 * 从 agent.ts 拆分，职责单一
 */

import { loadSession } from "../session/store"
import type { LLMMessage } from "../llm/client"
import type { ContextManager } from "../session/context"
import { repairMessageSequence } from "../shared/message-utils"

/** 检查 assistant 消息是否包含 tool_calls */
function hasToolCalls(content: string | any[]): boolean {
  if (Array.isArray(content)) {
    return content.some((p: any) => p.type === "tool-call")
  }
  return false
}

/** 尝试解析旧格式的 assistant 消息 */
function tryParseAssistantPayload(content: string): { text: string; tool_calls: Array<{ id: string; name: string; args: string }>; reasoning_content?: string } | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown; tool_calls?: unknown; reasoning_content?: unknown }
    if (parsed && typeof parsed === "object" && "text" in parsed && "tool_calls" in parsed) {
      return { text: String(parsed.text || ""), tool_calls: (parsed.tool_calls as Array<{ id: string; name: string; args: string }>) || [], reasoning_content: typeof parsed.reasoning_content === "string" ? parsed.reasoning_content : undefined }
    }
  } catch { /* json parse fallback */ }
  return null
}

/**
 * 恢复会话历史消息
 * @param sessionID 会话 ID
 * @param contextManager 上下文管理器（用于 checkpoint 重建）
 * @returns 恢复的消息列表 + 是否做了 checkpoint 重建
 */
export async function restoreSessionHistory(
  sessionID: string,
  contextManager: ContextManager,
): Promise<{ history: LLMMessage[]; didRebuild: boolean }> {
  const stored = await loadSession(sessionID)
  if (!stored || stored.messages.length === 0) {
    return { history: [], didRebuild: false }
  }

  const restored: LLMMessage[] = []

  for (const m of stored.messages) {
    if (m.role === "assistant") {
      // 尝试解析旧格式（JSON 序列化的 tool_calls）
      const parsed = tryParseAssistantPayload(m.content)
      if (parsed) {
        restored.push({
          role: "assistant",
          content: [
            { type: "text", text: parsed.text },
            ...parsed.tool_calls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.name,
              args: JSON.parse(tc.args),
            })),
          ],
          ...(parsed.reasoning_content ? { reasoning_content: parsed.reasoning_content } : {}),
        })
        continue
      }
      restored.push({ role: "assistant", content: m.content })
      continue
    }

    if (m.role === "tool") {
      if (!m.toolCallId) {
        restored.push({
          role: "tool",
          content: [{ type: "tool-result" as const, toolCallId: "unknown", toolName: "unknown", output: m.content }],
        })
        continue
      }
      // 尝试合并到上一条 assistant 消息的 tool_calls
      const lastAssistant = [...restored].reverse().find(r => r.role === "assistant")
      if (lastAssistant && !hasToolCalls(lastAssistant.content)) {
        lastAssistant.content += `\n\n[Tool result: ${m.content.slice(0, 500)}]`
        continue
      }
      restored.push({
        role: "tool",
        content: [{ type: "tool-result" as const, toolCallId: m.toolCallId, toolName: "unknown", output: m.content }],
        tool_call_id: m.toolCallId,
      })
      continue
    }

    restored.push({ role: "user", content: m.content })
  }

  // 修复消息序列（孤立 tool / 乱序 tool / 末尾 tool），确保发给 LLM 的序列合法
  const repaired = repairMessageSequence(restored)

  // 尝试从 checkpoint 重建上下文
  const rebuilt = contextManager.onSessionResume(repaired, sessionID)
  const didRebuild = rebuilt.length > repaired.length

  return { history: rebuilt, didRebuild }
}
