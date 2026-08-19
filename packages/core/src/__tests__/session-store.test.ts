import { describe, expect, test, afterEach } from 'vitest'
import { randomUUID } from 'crypto'
import { appendMessage, loadSession, deleteSession, messageCount } from '../session/store'

function sid() { return `store-test-${randomUUID().slice(0, 8)}` }
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

describe('session store loadSession', () => {
  test('消息超过 500 条时返回最新 500 条（保持时间顺序）', async () => {
    const sessionA = sid()
    used.push(sessionA)
    await seed(sessionA, 520)

    expect(await messageCount(sessionA)).toBe(520)

    const stored = await loadSession(sessionA)
    expect(stored).not.toBeNull()
    expect(stored!.messages).toHaveLength(500)
    // 取最新 500 条：第 20 条（0-based）——第 0~19 条（共 20 条）被截掉
    expect(stored!.messages[0].content).toBe('msg-20')
    expect(stored!.messages[499].content).toBe('msg-519')
  })

  test('按时间顺序返回（最旧在前）', async () => {
    const sessionB = sid()
    used.push(sessionB)
    await seed(sessionB, 30)

    const stored = await loadSession(sessionB)
    expect(stored).not.toBeNull()
    expect(stored!.messages[0].content).toBe('msg-0')
    expect(stored!.messages[29].content).toBe('msg-29')
  })
})

afterEach(() => {
  for (const sid of used) {
    deleteSession(sid)
  }
  used.length = 0
})