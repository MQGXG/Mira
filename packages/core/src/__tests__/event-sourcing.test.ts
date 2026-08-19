/**
 * 事件溯源闭环测试 — 事件为唯一事实源，messages 表为投影缓存
 *
 * 覆盖：
 * 1. appendMessage → 事件 + 投影缓存
 * 2. loadSession 从事件重建（快照 + 增量）
 * 3. deleteMessage 追加删除事件并重建缓存
 * 4. Projector 判别联合收窄 + seq 消息身份
 * 5. SessionEventMap 可合并扩展（declaration merging）
 */

import { describe, expect, test, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { appendMessage, loadSession, deleteMessage, deleteSession, messageCount } from '../session/store'
import { getEventStore } from '../session/event-store'
import { getProjector } from '../session/projector'
import {
  createMessageEvent,
  type SessionEvent,
  type SessionEventMap,
  type EventType,
} from '../session/event-types'

// 通过 declaration merging 为 SessionEventMap 增加新事件类型（演示插件扩展能力）
declare module '../session/event-types' {
  interface SessionEventMap {
    'custom.ping': { message: string }
  }
}

function sid() { return `event-sourcing-${randomUUID().slice(0, 8)}` }
const used: string[] = []

async function seed(sessionID: string, n: number) {
  for (let i = 0; i < n; i++) {
    await appendMessage(sessionID, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}`,
      timestamp: new Date(Date.now() + i).toISOString(),
    })
  }
}

describe('事件溯源闭环', () => {
  test('appendMessage 写入事件并同步投影缓存', async () => {
    const s = sid()
    used.push(s)
    await appendMessage(s, { role: 'user', content: 'hello', timestamp: new Date().toISOString() })

    // 事件层有记录
    const store = getEventStore()
    expect(await store.getLatestSeq(s)).toBeGreaterThan(0)
    const events = await store.getEvents(s)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('message.appended')
    // 判别联合收窄：payload 可直接访问
    if (events[0].type === 'message.appended') {
      expect(events[0].payload.role).toBe('user')
      expect(events[0].payload.content).toBe('hello')
    }
  })

  test('loadSession 从事件重建并返回 seq 作为消息 id', async () => {
    const s = sid()
    used.push(s)
    await seed(s, 5)

    const stored = await loadSession(s)
    expect(stored).not.toBeNull()
    expect(stored!.messages).toHaveLength(5)
    expect(stored!.messages[0].content).toBe('msg-0')
    // 逻辑 id = 事件 seq（从 1 递增）
    expect(stored!.messages[0].id).toBe(1)
    expect(stored!.messages[4].id).toBe(5)
  })

  test('loadSession 从快照 + 增量事件重建', async () => {
    const s = sid()
    used.push(s)
    await seed(s, 3)

    // 保存快照（up_to_seq = 2），再追加事件
    const store = getEventStore()
    const events = await store.getEvents(s)
    const snapshot = getProjector().serializeSnapshot(
      getProjector().replay(events.slice(0, 2)),
    )
    store.saveSnapshot({
      session_id: s,
      up_to_seq: 2,
      messages_json: snapshot,
      metadata_json: '{}',
      created_at: new Date().toISOString(),
    })
    await appendMessage(s, { role: 'assistant', content: 'msg-3', timestamp: new Date().toISOString() })

    // 快照之后的事件（seq > 2）才被回放：seed 的 seq 3 + 新增的 seq 4
    const afterSnapshot = await store.getEvents(s, 2)
    expect(afterSnapshot).toHaveLength(2)
    expect(afterSnapshot.every(e => e.type === 'message.appended')).toBe(true)

    const stored = await loadSession(s)
    expect(stored!.messages).toHaveLength(4)
    expect(stored!.messages[3].content).toBe('msg-3')
  })

  test('deleteMessage 追加删除事件并从事件重建缓存', async () => {
    const s = sid()
    used.push(s)
    await seed(s, 5)

    // 删除第 2 条消息（id = seq = 2）
    await deleteMessage(s, 2)

    // 事件层有 message.deleted
    const store = getEventStore()
    const events = await store.getEvents(s)
    expect(events.some(e => e.type === 'message.deleted')).toBe(true)

    // 缓存重建后消息数 4，原 msg-1 被移除
    const stored = await loadSession(s)
    expect(stored!.messages).toHaveLength(4)
    expect(stored!.messages.some(m => m.content === 'msg-1')).toBe(false)
    expect(stored!.messages[0].content).toBe('msg-0')
  })

  test('deleteMessage 后再 loadSession 保持与事件一致', async () => {
    const s = sid()
    used.push(s)
    await seed(s, 10)
    await deleteMessage(s, 1) // 删 msg-0
    await deleteMessage(s, 10) // 删 msg-9

    const stored = await loadSession(s)
    expect(stored!.messages).toHaveLength(8)
    expect(stored!.messages[0].content).toBe('msg-1')
    expect(stored!.messages[stored!.messages.length - 1].content).toBe('msg-8')
    expect(await messageCount(s)).toBe(8)
  })

  test('无事件的历史数据回退读 messages 缓存表', async () => {
    const s = sid()
    used.push(s)
    // 直接写入缓存表（模拟历史数据，无事件）
    await appendMessage(s, { role: 'user', content: 'legacy', timestamp: new Date().toISOString() })
    // 手动清除事件层，模拟事件缺失的历史会话
    const { getDbAsync } = await import('../system/database')
    const db = await getDbAsync()
    db.run('DELETE FROM session_events WHERE session_id = ?', [s])

    const stored = await loadSession(s)
    expect(stored).not.toBeNull()
    expect(stored!.messages).toHaveLength(1)
    expect(stored!.messages[0].content).toBe('legacy')
  })
})

describe('Projector 消息身份与投影', () => {
  test('project 追加消息 id = 事件 seq', () => {
    const projector = getProjector()
    const messages = projector.replay([
      createMessageEvent('s1', { role: 'user', content: 'a' }).type === 'message.appended'
        ? { seq: 1, session_id: 's1', type: 'message.appended' as const, payload: { role: 'user' as const, content: 'a' }, timestamp: '', version: 1 }
        : null,
    ].filter((e): e is NonNullable<typeof e> => e !== null))

    expect(messages[0].id).toBe(1)
    expect(messages[0].content).toBe('a')
  })

  test('message.edited 按 id 更新内容', () => {
    const projector = getProjector()
    const messages = projector.project([], [
      { seq: 1, session_id: 's1', type: 'message.appended', payload: { role: 'user', content: 'old' }, timestamp: '', version: 1 },
      { seq: 2, session_id: 's1', type: 'message.edited', payload: { messageId: 1, newContent: 'new' }, timestamp: '', version: 1 },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('new')
  })

  test('session.compacted 为 log-only 不影响消息投影', () => {
    const projector = getProjector()
    const messages = projector.project([], [
      { seq: 1, session_id: 's1', type: 'message.appended', payload: { role: 'user', content: 'a' }, timestamp: '', version: 1 },
      { seq: 2, session_id: 's1', type: 'session.compacted', payload: { reason: 'overflow', messagesBefore: 1, messagesAfter: 1, tokensBefore: 0, tokensAfter: 0, compactedMessages: [] }, timestamp: '', version: 1 },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('a')
  })
})

describe('SessionEventMap 可合并扩展', () => {
  test('新事件类型可通过 keyof 派生', () => {
    const type: EventType = 'custom.ping'
    expect(type).toBe('custom.ping')

    // 新类型的 payload 可访问
    const ping = { message: 'hello' } satisfies SessionEventMap['custom.ping']
    expect(ping.message).toBe('hello')
  })

  test('判别联合覆盖新事件', () => {
    const event: SessionEvent = {
      seq: 1, session_id: 's1', type: 'custom.ping',
      payload: { message: 'hi' }, timestamp: '', version: 1,
    }
    if (event.type === 'custom.ping') {
      expect(event.payload.message).toBe('hi')
    }
  })
})

afterEach(() => {
  for (const sid of used) {
    deleteSession(sid)
  }
  used.length = 0
})
