/**
 * 事件类型定义 — 对标 DeepSeek Harness 的 Map → derived-union 模式
 *
 * 所有会话状态变化都通过事件记录，messages 表降级为事件投影缓存。
 * 通过 SessionEventMap 接口 + keyof 派生 EventType，插件可通过
 * declaration merging 扩展新事件类型（无需修改本文件）。
 */

// ── 具体事件负载类型 ────────────────────────────────────

export interface MessageAppendedPayload {
  role: "user" | "assistant" | "tool"
  content: string
  toolCallId?: string
  retryCount?: number
}

export interface MessageEditedPayload {
  /** 消息身份（= 追加该消息的事件 seq） */
  messageId: number
  newContent: string
  reason?: string
}

export interface MessageDeletedPayload {
  /** 消息身份（= 追加该消息的事件 seq） */
  messageId: number
}

/** Surface 替换负载：以一条新消息替换日志中一段已存在消息范围（折叠历史） */
export interface MessageReplacedPayload {
  /** 新消息（替换后进入 surface 的节点） */
  content: string
  role: "user" | "assistant" | "tool"
  /** 被替换的包含 seq 范围（surface 折叠引用） */
  replaces: { start: number; end: number }
  toolCallId?: string
  reason?: string
}

export interface SessionCreatedPayload {
  project_id?: string
  title?: string
  workspace?: string
}

export interface SessionTitleUpdatedPayload {
  newTitle: string
  oldTitle?: string
}

export interface SessionCompactedPayload {
  reason: string
  messagesBefore: number
  messagesAfter: number
  tokensBefore: number
  tokensAfter: number
  compactedMessages: Array<{ role: string; content: string }>
}

export interface ContextRebuiltPayload {
  reason: string
  tokensBefore: number
  tokensAfter: number
}

export interface CheckpointSavedPayload {
  summary: string
  activeTask?: string
  keyFiles?: string[]
}

export interface ToolExecutedPayload {
  toolName: string
  toolCallId: string
  args: Record<string, unknown>
  result: { success: boolean; output?: string; error?: string }
  durationMs: number
}

export interface GoalCreatedPayload {
  goalId: string
  description: string
  timeoutMs?: number
}

export interface GoalSatisfiedPayload {
  goalId: string
  reasoning: string
  confidence: number
}

export interface ForkCreatedPayload {
  sourceSessionId: string
  targetSessionId: string
  atMessageId?: number
}

/** Inbox 队列变更负载（投递/消费/丢弃持久化，可回放重建待办） */
export interface InboxSplicedPayload {
  ops: Array<{
    op: "insert" | "delete"
    boundary: "next-turn" | "next-step"
    index: number
    item?: { message: string; type: string }
  }>
}

// ── SessionEventMap：事件名 → 负载类型的映射 ───────────────
// 插件扩展新事件类型的方式（无需改动本文件）：
//   declare module "@mira/core" {
//     interface SessionEventMap {
//       "skill.invoked": SkillInvokedPayload
//     }
//   }

export interface SessionEventMap {
  "message.appended": MessageAppendedPayload
  "message.edited": MessageEditedPayload
  "message.deleted": MessageDeletedPayload
  "message.replaced": MessageReplacedPayload
  "session.created": SessionCreatedPayload
  "session.title_updated": SessionTitleUpdatedPayload
  "session.compacted": SessionCompactedPayload
  "context.rebuilt": ContextRebuiltPayload
  "checkpoint.saved": CheckpointSavedPayload
  "tool.executed": ToolExecutedPayload
  "goal.created": GoalCreatedPayload
  "goal.satisfied": GoalSatisfiedPayload
  "fork.created": ForkCreatedPayload
  "inbox.spliced": InboxSplicedPayload
}

/** 事件类型 = SessionEventMap 的键 */
export type EventType = keyof SessionEventMap

/**
 * 判别联合事件：switch(event.type) 自动收窄 payload。
 * SessionEvent 是全部事件类型的联合；SessionEvent<"message.appended">
 * 只表示单一种类。
 */
export type SessionEvent<K extends EventType = EventType> = {
  [T in EventType]: {
    /** 事件在聚合内的序列号（单调递增） */
    seq: number
    /** 会话 ID */
    session_id: string
    /** 事件类型 */
    type: T
    /** 事件负载（按 type 收窄） */
    payload: SessionEventMap[T]
    /** 事件创建时间 */
    timestamp: string
    /** 事件 schema 版本（用于演进） */
    version: number
  }
}[K]

// ── 事件快照 ────────────────────────────────────────────

export interface EventSnapshot {
  snapshot_id: string
  session_id: string
  /** 快照对应的 seq 号 */
  up_to_seq: number
  /** 快照时的消息列表（投影结果） */
  messages_json: string
  /** 快照时的元数据 */
  metadata_json: string
  created_at: string
}

// ── 辅助函数 ────────────────────────────────────────────

/** 创建消息追加事件 */
export function createMessageEvent(
  sessionId: string,
  message: MessageAppendedPayload,
  timestamp?: string,
): Omit<SessionEvent<"message.appended">, "seq"> {
  return {
    session_id: sessionId,
    type: "message.appended",
    payload: message,
    timestamp: timestamp || new Date().toISOString(),
    version: 1,
  }
}

/** 创建消息编辑事件 */
export function createMessageEditedEvent(
  sessionId: string,
  edit: MessageEditedPayload,
): Omit<SessionEvent<"message.edited">, "seq"> {
  return {
    session_id: sessionId,
    type: "message.edited",
    payload: edit,
    timestamp: new Date().toISOString(),
    version: 1,
  }
}

/** 创建消息删除事件 */
export function createMessageDeletedEvent(
  sessionId: string,
  del: MessageDeletedPayload,
): Omit<SessionEvent<"message.deleted">, "seq"> {
  return {
    session_id: sessionId,
    type: "message.deleted",
    payload: del,
    timestamp: new Date().toISOString(),
    version: 1,
  }
}

/** 创建 surface 替换事件 */
export function createMessageReplacedEvent(
  sessionId: string,
  replaced: MessageReplacedPayload,
): Omit<SessionEvent<"message.replaced">, "seq"> {
  return {
    session_id: sessionId,
    type: "message.replaced",
    payload: replaced,
    timestamp: new Date().toISOString(),
    version: 1,
  }
}

/** 创建会话压缩事件 */
export function createCompactionEvent(
  sessionId: string,
  compaction: SessionCompactedPayload,
): Omit<SessionEvent<"session.compacted">, "seq"> {
  return {
    session_id: sessionId,
    type: "session.compacted",
    payload: compaction,
    timestamp: new Date().toISOString(),
    version: 1,
  }
}

/** 创建工具执行事件 */
export function createToolEvent(
  sessionId: string,
  tool: ToolExecutedPayload,
): Omit<SessionEvent<"tool.executed">, "seq"> {
  return {
    session_id: sessionId,
    type: "tool.executed",
    payload: tool,
    timestamp: new Date().toISOString(),
    version: 1,
  }
}

/** 创建 Inbox 队列变更事件 */
export function createInboxSplicedEvent(
  sessionId: string,
  splice: InboxSplicedPayload,
): Omit<SessionEvent<"inbox.spliced">, "seq"> {
  return {
    session_id: sessionId,
    type: "inbox.spliced",
    payload: splice,
    timestamp: new Date().toISOString(),
    version: 1,
  }
}
