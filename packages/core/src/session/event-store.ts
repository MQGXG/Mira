/**
 * EventStore — 事件溯源层
 *
 * 所有会话状态变化都通过事件记录。事件追加到 session_events 表，
 * 并通过 Projector 投影到 messages 表。支持事件回放和状态重建。
 */

import { getDbAsync, runWrite } from "../system/database"
import type { SessionEvent, EventType, EventSnapshot, SessionEventMap } from "./event-types"

export class EventStore {
  /**
   * 追加事件到事件流
   * seq 单调递增，替代时间戳排序，解决时钟漂移问题
   */
  async append<K extends EventType>(event: Omit<SessionEvent<K>, "seq">): Promise<number> {
    const db = await getDbAsync()

    // 获取当前最大 seq
    const seqResult = db.exec(
      "SELECT COALESCE(MAX(seq), 0) + 1 FROM session_events WHERE session_id = ?",
      [event.session_id],
    )
    const seq = (seqResult[0]?.values[0]?.[0] as number) || 1

    runWrite(
      `INSERT INTO session_events (seq, session_id, type, payload, timestamp, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        seq,
        event.session_id,
        event.type,
        JSON.stringify(event.payload),
        event.timestamp,
        event.version || 1,
      ],
    )

    return seq
  }

  /** 将 DB 行转换为类型化事件（payload 与 type 由写入端保证一致） */
  private rowToEvent<T extends EventType>(
    row: unknown[],
    type: T,
  ): SessionEvent<T> {
    return {
      seq: row[0] as number,
      session_id: row[1] as string,
      type,
      payload: JSON.parse(row[3] as string) as SessionEventMap[T],
      timestamp: row[4] as string,
      version: row[5] as number,
    } as SessionEvent<T>
  }

  /**
   * 读取事件流
   * @param sessionId 会话 ID
   * @param afterSeq 可选：从该 seq 之后开始读取（用于增量回放）
   */
  async getEvents(sessionId: string, afterSeq?: number): Promise<SessionEvent[]> {
    const db = await getDbAsync()
    const sql = afterSeq
      ? "SELECT seq, session_id, type, payload, timestamp, version FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC"
      : "SELECT seq, session_id, type, payload, timestamp, version FROM session_events WHERE session_id = ? ORDER BY seq ASC"
    const params = afterSeq ? [sessionId, afterSeq] : [sessionId]
    const result = db.exec(sql, params)
    if (result.length === 0) return []

    return result[0].values.map(row =>
      this.rowToEvent(row, row[2] as EventType),
    )
  }

  /**
   * 获取最新 seq 号
   */
  async getLatestSeq(sessionId: string): Promise<number> {
    const db = await getDbAsync()
    const result = db.exec(
      "SELECT COALESCE(MAX(seq), 0) FROM session_events WHERE session_id = ?",
      [sessionId],
    )
    return (result[0]?.values[0]?.[0] as number) || 0
  }

  /**
   * 获取指定类型的事件
   */
  async getEventsByType<K extends EventType>(sessionId: string, type: K): Promise<SessionEvent<K>[]> {
    const db = await getDbAsync()
    const result = db.exec(
      "SELECT seq, session_id, type, payload, timestamp, version FROM session_events WHERE session_id = ? AND type = ? ORDER BY seq ASC",
      [sessionId, type],
    )
    if (result.length === 0) return []

    return result[0].values.map(row => this.rowToEvent(row, type))
  }

  /**
   * 保存事件快照 — 避免每次从头回放
   */
  saveSnapshot(snapshot: Omit<EventSnapshot, "snapshot_id">): string {
    const id = `snap_${Date.now().toString(36)}`
    runWrite(
      `INSERT INTO event_snapshots (snapshot_id, session_id, up_to_seq, messages_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        snapshot.session_id,
        snapshot.up_to_seq,
        snapshot.messages_json,
        snapshot.metadata_json,
        snapshot.created_at,
      ],
    )
    return id
  }

  /**
   * 获取最新快照
   */
  async getLatestSnapshot(sessionId: string): Promise<EventSnapshot | null> {
    const db = await getDbAsync()
    const result = db.exec(
      `SELECT snapshot_id, session_id, up_to_seq, messages_json, metadata_json, created_at
       FROM event_snapshots WHERE session_id = ? ORDER BY up_to_seq DESC LIMIT 1`,
      [sessionId],
    )
    if (result.length === 0 || result[0].values.length === 0) return null
    const row = result[0].values[0]
    return {
      snapshot_id: row[0] as string,
      session_id: row[1] as string,
      up_to_seq: row[2] as number,
      messages_json: row[3] as string,
      metadata_json: row[4] as string,
      created_at: row[5] as string,
    }
  }

  /**
   * 删除指定 seq 之前的事件（用于清理）
   */
  async pruneEvents(sessionId: string, beforeSeq: number): Promise<number> {
    const db = await getDbAsync()
    const countResult = db.exec(
      "SELECT COUNT(*) FROM session_events WHERE session_id = ? AND seq < ?",
      [sessionId, beforeSeq],
    )
    const count = (countResult[0]?.values[0]?.[0] as number) || 0
    if (count > 0) {
      runWrite(
        "DELETE FROM session_events WHERE session_id = ? AND seq < ?",
        [sessionId, beforeSeq],
      )
    }
    return count
  }
}

// ── 全局单例 ────────────────────────────────────────────

let _instance: EventStore | null = null

export function getEventStore(): EventStore {
  if (!_instance) {
    _instance = new EventStore()
  }
  return _instance
}
