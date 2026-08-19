import type { ThreadMessageLike } from "@assistant-ui/react";
import type { MiraMessage, MiraPart, MessageTiming } from "./types-message";

export type { MiraMessage, MiraPart, MessageTiming };
export type { ToolCallInfo, AgentMode } from "./types";
export type { DiffFileEntry } from "./types-message";

/** 默认导出 MiraMessage 给其他模块引用 */
export type { MiraMessage as default } from "./types-message";

/** 将 MiraMessage 转换为 assistant-ui 的 ThreadMessageLike */
export function convertMessage(message: MiraMessage): ThreadMessageLike {
  const content: Array<Extract<ThreadMessageLike["content"], readonly unknown[]>[number]> = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      // 保留空 text part 作为稳定占位，避免流式过程中索引漂移导致渲染闪烁
      content.push({ type: "text", text: part.text || "" });
    } else if (part.type === "tool-call") {
      content.push({
        type: "tool-call",
        toolCallId: part.toolCallId!,
        toolName: part.toolName!,
        args: part.args as any,
      });
    } else if (part.type === "file" && part.url) {
      // 用户上传的图片回显：转为 assistant-ui 的 image content
      content.push({ type: "image", image: part.url });
    }
  }

  return {
    role: message.role,
    content: content.length > 0 ? content : "",
    id: message.id,
    createdAt: message.createdAt,
    metadata: {
      ...(message.timing ? { timing: message.timing, custom: {} } : {}),
      ...(message.error ? { custom: { error: message.error } } : {}),
    },
  };
}

/** 创建新消息 */
export function createMiraMessage(
  role: "user" | "assistant",
  partsOrText?: MiraPart[] | string,
  id?: string
): MiraMessage {
  let parts: MiraPart[] = [];
  if (Array.isArray(partsOrText)) {
    parts = partsOrText;
  } else if (typeof partsOrText === "string" && partsOrText) {
    parts = [{ type: "text", text: partsOrText }];
  }
  return {
    id: id || crypto.randomUUID(),
    role,
    parts,
    createdAt: new Date(),
  };
}

/** 向消息追加文本（合并到最后一个 text part，或新增） */
export function appendText(
  message: MiraMessage,
  text: string
): MiraMessage {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = { ...last, text: (last.text || "") + text };
  } else {
    parts.push({ type: "text", text });
  }
  return { ...message, parts };
}

/** 向消息追加 thinking part */
export function appendThinking(
  message: MiraMessage,
  text: string
): MiraMessage {
  const parts = [...message.parts];
  const last = parts[parts.length - 1];
  if (last?.type === "thinking") {
    parts[parts.length - 1] = { ...last, text: (last.text || "") + text };
  } else {
    parts.push({ type: "thinking", text });
  }
  return { ...message, parts };
}

/** 向消息追加 reasoning part（按 ID 追踪，对齐 opencode processor） */
export function appendReasoning(
  message: MiraMessage,
  id: string,
  text: string
): MiraMessage {
  const parts = [...message.parts];
  const existing = parts.findIndex(
    (p) => p.type === "reasoning" && p.reasoningId === id
  );
  if (existing >= 0) {
    const part = parts[existing];
    parts[existing] = { ...part, text: (part.text || "") + text };
  } else {
    parts.push({
      type: "reasoning",
      reasoningId: id,
      text,
      time: { start: Date.now() },
    });
  }
  return { ...message, parts };
}

/** 完成 reasoning part（设置 end 时间） */
export function finishReasoning(
  message: MiraMessage,
  id: string
): MiraMessage {
  return {
    ...message,
    parts: message.parts.map((p) =>
      p.type === "reasoning" && p.reasoningId === id
        ? { ...p, time: { start: p.time?.start ?? Date.now(), end: Date.now() } }
        : p
    ),
  };
}

/** 添加 tool-call part */
export function addToolCall(
  message: MiraMessage,
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>
): MiraMessage {
  return {
    ...message,
    parts: [
      ...message.parts,
      {
        type: "tool-call",
        toolCallId,
        toolName,
        args,
        status: "running",
      },
    ],
  };
}

/** 更新 tool-call part 结果 */
export function updateToolCall(
  message: MiraMessage,
  toolCallId: string,
  status: "done" | "error",
  result: string,
  snapshotId?: string
): MiraMessage {
  return {
    ...message,
    parts: message.parts.map((p) =>
      p.type === "tool-call" && p.toolCallId === toolCallId
        ? { ...p, status, result, snapshotId: snapshotId || p.snapshotId }
        : p
    ),
  };
}

/** 添加 compaction part — 上下文压缩标记 */
export function addCompaction(
  message: MiraMessage,
  reason: string,
  tokensBefore: number,
  tokensAfter: number
): MiraMessage {
  const label = reason === "checkpoint_rebuild" ? "Checkpoint restored"
    : reason === "proactive_rebuild" ? "Proactive checkpoint"
    : reason === "llm_summary" ? "Context compressed"
    : "Context compacted";
  return {
    ...message,
    parts: [
      ...message.parts,
      { type: "compaction", text: label, compaction: { reason, tokensBefore, tokensAfter } },
    ],
  };
}

/** 添加 diff-summary part */
export function addDiffSummary(
  message: MiraMessage,
  files: import("./types-message").DiffFileEntry[]
): MiraMessage {
  return {
    ...message,
    parts: [...message.parts, { type: "diff-summary", files }],
  };
}
