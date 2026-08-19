import { getDbAsync, runWrite } from "../system/database"
import { getEventStore } from "./event-store"
import { createMessageEvent, createMessageDeletedEvent } from "./event-types"
import { getProjector } from "./projector"

export interface StoredMessage {
  /** 消息逻辑身份（= 追加该消息的事件 seq），由事件投影派生 */
  id?: number
  role: "user" | "assistant" | "tool"
  content: string
  timestamp: string
  toolCallId?: string
  retryCount?: number
}

export interface StoredSession {
  id: string
  title: string
  created: string
  updated: string
  messages: StoredMessage[]
  workspace: string
}

/** 对外返回的消息窗口上限（与旧读取行为一致，事件层仍保留完整历史） */
const MESSAGE_WINDOW = 500

/**
 * 追加消息到会话 — 事件为唯一事实源，messages 表降级为投影缓存。
 * 事件写入失败记录日志但不阻断投影（保证降级可用）。
 */
export async function appendMessage(sessionID: string, message: StoredMessage): Promise<void> {
  // 1. 追加事件（唯一事实源）
  try {
    const eventStore = getEventStore()
    await eventStore.append(createMessageEvent(sessionID, {
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      retryCount: message.retryCount,
    }))
  } catch (e) {
    // 事件层失败不阻断主流程，但记录日志便于排查
    console.error("[session] append event failed:", e)
  }

  // 2. 投影缓存（messages 表 + FTS + 会话标题）
  const db = await getDbAsync()

  const existing = db.exec("SELECT title FROM sessions WHERE session_id = ?", [sessionID])
  const isNew = existing.length === 0 || existing[0].values.length === 0

  if (isNew) {
    runWrite(
      "INSERT OR IGNORE INTO sessions (session_id, project_id, title, workspace, created_at, updated_at) VALUES (?, '', ?, '', datetime('now'), datetime('now'))",
      [sessionID, `会话 ${new Date().toLocaleDateString("zh-CN")}`],
    )
  }

  const isFirstUserMessage = message.role === "user" && message.content.trim()
    && Number(db.exec("SELECT COUNT(*) FROM messages WHERE session_id = ? AND role = 'user'", [sessionID])[0]?.values[0] || 0) === 0

  runWrite(
    "INSERT INTO messages (session_id, role, content, timestamp, tool_call_id, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
    [sessionID, message.role, message.content, message.timestamp, message.toolCallId || null, message.retryCount || 0],
  )

  // 同步 FTS5 索引（FTS5 不可用时静默）
  try {
    runWrite("INSERT INTO messages_fts(session_id, role, content) VALUES (?, ?, ?)",
      [sessionID, message.role, message.content])
  } catch { /* FTS5 不可用 */ }

  runWrite("UPDATE sessions SET updated_at = ? WHERE session_id = ?", [new Date().toISOString(), sessionID])

  if (isFirstUserMessage) {
    const preview = message.content.trim().slice(0, 50)
    runWrite("UPDATE sessions SET title = ? WHERE session_id = ?", [preview, sessionID])
  }
}

/** 从 messages 表读取投影缓存（历史数据回退路径） */
async function readCache(sessionID: string): Promise<StoredMessage[]> {
  const db = await getDbAsync()
  const msgResult = db.exec(
    "SELECT id, role, content, timestamp, tool_call_id, retry_count FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    [sessionID, MESSAGE_WINDOW],
  )
  if (msgResult.length === 0 || msgResult[0].values.length === 0) return []
  // DESC 取最新后反转为时间正序（最旧在前），保证调用方顺序语义不变
  return msgResult[0].values.reverse().map((r) => ({
    id: r[0] as number,
    role: r[1] as StoredMessage["role"],
    content: r[2] as string,
    timestamp: r[3] as string,
    ...(r[4] ? { toolCallId: r[4] as string } : {}),
    retryCount: r[5] as number | undefined,
  }))
}

/** 将完整投影结果回写 messages 缓存表 + FTS 索引（物理 id 由自增主键分配） */
function writeCache(sessionID: string, messages: StoredMessage[]): void {
  runWrite("DELETE FROM messages WHERE session_id = ?", [sessionID])
  for (const m of messages) {
    runWrite(
      "INSERT INTO messages (session_id, role, content, timestamp, tool_call_id, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      [sessionID, m.role, m.content, m.timestamp, m.toolCallId || null, m.retryCount || 0],
    )
  }
  // FTS 索引同步重建（FTS5 不可用时静默）
  try {
    runWrite("DELETE FROM messages_fts WHERE session_id = ?", [sessionID])
    for (const m of messages) {
      runWrite("INSERT INTO messages_fts(session_id, role, content) VALUES (?, ?, ?)",
        [sessionID, m.role, m.content])
    }
  } catch { /* FTS5 不可用 */ }
}

/**
 * 从事件流完整重建会话消息（快照 + 增量投影），返回逻辑消息（id = 事件 seq）。
 * 会话无事件时返回 null（调用方回退读缓存表）。
 */
async function rebuildFromEvents(sessionID: string): Promise<StoredMessage[] | null> {
  const eventStore = getEventStore()
  const latestSeq = await eventStore.getLatestSeq(sessionID)
  if (latestSeq <= 0) return null

  const projector = getProjector()
  const snapshot = await eventStore.getLatestSnapshot(sessionID)
  if (snapshot) {
    const events = await eventStore.getEvents(sessionID, snapshot.up_to_seq)
    return projector.projectFromSnapshot(snapshot, events)
  }
  const events = await eventStore.getEvents(sessionID)
  return projector.replay(events)
}

/**
 * 读取会话 — 事件为唯一事实源，messages 表为投影缓存。
 * 有事件时经快照 + 增量投影重建并回写缓存；无事件（历史数据）回退读缓存表。
 */
export async function loadSession(sessionID: string): Promise<StoredSession | null> {
  try {
    const db = await getDbAsync()
    const result = db.exec("SELECT session_id, title, created_at, updated_at, workspace FROM sessions WHERE session_id = ?", [sessionID])
    if (result.length === 0 || result[0].values.length === 0) return null

    const row = result[0].values[0]
    const [id, title, created, updated, workspace] = row as string[]

    let messages: StoredMessage[]

    const rebuilt = await rebuildFromEvents(sessionID)
    if (rebuilt) {
      messages = rebuilt
      // 回写投影缓存（修复可能存在的缓存漂移）
      writeCache(sessionID, messages)
    } else {
      // 历史数据（无事件）回退读 messages 表
      messages = await readCache(sessionID)
    }

    // 对外窗口：与旧行为一致，保留最近 N 条
    if (messages.length > MESSAGE_WINDOW) {
      messages = messages.slice(-MESSAGE_WINDOW)
    }

    return { id, title, created, updated, messages, workspace }
  } catch {
    return null
  }
}

export async function createSession(sessionID: string, workspace: string): Promise<StoredSession> {
  const now = new Date().toISOString()
  const session: StoredSession = {
    id: sessionID,
    title: `会话 ${new Date().toLocaleDateString("zh-CN")}`,
    created: now,
    updated: now,
    messages: [],
    workspace,
  }
  await getDbAsync()
  runWrite(
    "INSERT OR IGNORE INTO sessions (session_id, project_id, title, workspace, created_at, updated_at) VALUES (?, '', ?, ?, ?, ?)",
    [sessionID, session.title, workspace, now, now],
  )
  return session
}

export async function listSessions(): Promise<StoredSession[]> {
  try {
    const db = await getDbAsync()
    const result = db.exec("SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT 100")
    if (result.length === 0) return []
    const results = await Promise.all(
      result[0].values.map((row) => loadSession(String(row[0]))),
    )
    return results.filter((s): s is StoredSession => s !== null)
  } catch {
    return []
  }
}

export function deleteSession(sessionID: string): void {
  runWrite("DELETE FROM session_events WHERE session_id = ?", [sessionID])
  runWrite("DELETE FROM event_snapshots WHERE session_id = ?", [sessionID])
  runWrite("DELETE FROM messages WHERE session_id = ?", [sessionID])
  runWrite("DELETE FROM sessions WHERE session_id = ?", [sessionID])
}

/**
 * 删除单条消息（UI 重试/编辑历史消息时清理旧记录）
 * 追加删除事件（messageId = 事件 seq）后重建投影缓存，保证事件与缓存一致。
 */
export async function deleteMessage(sessionID: string, messageId: number): Promise<void> {
  // 1. 追加删除事件（唯一事实源）
  try {
    const eventStore = getEventStore()
    await eventStore.append(createMessageDeletedEvent(sessionID, { messageId }))
  } catch (e) {
    console.error("[session] append delete event failed:", e)
  }

  // 2. 从事件流重建缓存（反映删除后的状态）
  const rebuilt = await rebuildFromEvents(sessionID)
  if (rebuilt) {
    writeCache(sessionID, rebuilt)
  } else {
    // 无事件的历史数据：直接按物理 id 删除缓存行
    runWrite("DELETE FROM messages WHERE session_id = ? AND id = ?", [sessionID, messageId])
  }
}

export async function messageCount(sessionID: string): Promise<number> {
  try {
    const db = await getDbAsync()
    const result = db.exec("SELECT COUNT(*) FROM messages WHERE session_id = ?", [sessionID])
    if (result.length === 0 || result[0].values.length === 0) return 0
    return (result[0].values[0][0] as number) || 0
  } catch {
    return 0
  }
}