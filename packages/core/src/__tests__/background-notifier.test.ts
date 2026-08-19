import { describe, expect, test, vi } from 'vitest'
import { BackgroundNotifier, setBackgroundNotifier, backgroundNotifier, startBackground } from '../background'
import { AnnouncementWindow } from '../voice/announcement-window'

describe('BackgroundNotifier', () => {
  test('adds notification with speech text', () => {
    const n = new BackgroundNotifier()
    const notif = n.addNotification('构建任务', '构建失败')
    expect(notif.status).toBe('pending')
    expect(n.pendingCount).toBe(1)
    expect(n.list()).toHaveLength(1)
  })

  test('claimReady returns FIFO and sets delivering', () => {
    const n = new BackgroundNotifier()
    n.addNotification('A', '第一条')
    n.addNotification('B', '第二条')
    const first = n.claimReady()!
    expect(first.message).toBe('第一条')
    expect(first.status).toBe('delivering')
    expect(n.pendingCount).toBe(2) // delivering 计入 pendingCount
    const second = n.claimReady()!
    expect(second.message).toBe('第二条')
    expect(n.claimReady()).toBeNull()
  })

  test('blocked window prevents claiming (keeps queue)', () => {
    const gates = {
      blocked: true,
      isBlocked: () => gates.blocked,
    }
    const n = new BackgroundNotifier({ window: gates })
    n.addNotification('A', 'x')
    expect(n.claimReady()).toBeNull()
    gates.blocked = false
    expect(n.claimReady()?.message).toBe('x')
  })

  test('markDelivered transitions and retry falls back to pending', () => {
    const n = new BackgroundNotifier()
    const notif = n.addNotification('A', 'x')
    n.claimReady()
    expect(n.markDelivered(notif.id)).toBe(true)
    expect(n.list()[0].status).toBe('delivered')
  })

  test('retry lets claiming work after failure', () => {
    const n = new BackgroundNotifier()
    const notif = n.addNotification('A', 'x')
    n.claimReady()
    expect(n.retry(notif.id)).toBe(true)
    const reclaimed = n.claimReady()!
    expect(reclaimed.id).toBe(notif.id)
    expect(reclaimed.status).toBe('delivering')
  })

  test('uses custom speechFor', () => {
    const n = new BackgroundNotifier({ speechFor: (t, m) => `通知：${t}: ${m}` })
    const notif = n.addNotification('构建', '完成')
    expect(notif.speech).toBe('通知：构建: 完成')
  })

  test('prunes expired pending notifications', () => {
    const n = new BackgroundNotifier({ pendingTtlMs: 10 })
    const notif = n.addNotification('A', 'x')
    // 直接推进内部时间（模拟过期）
    ;(n as unknown as { notifications: Map<string, unknown> }).notifications.set(
      notif.id,
      { ...notif, createdAt: Date.now() - 1000 },
    )
    expect(n.list()).toHaveLength(0)
    expect(n.pendingCount).toBe(0)
  })

  test('addTaskResult maps status to verbs', () => {
    const n = new BackgroundNotifier()
    const compl = n.addTaskResult('completed', '构建')
    expect(compl.message).toContain('已完成')
    const fail = n.addTaskResult('failed', '测试', '端口占用')
    expect(fail.message).toContain('失败了')
    expect(fail.message).toContain('端口占用')
  })
})

describe('background integration with notifier', () => {
  test('startBackground announces completion', async () => {
    const n = new BackgroundNotifier()
    setBackgroundNotifier(n)
    try {
      const id = startBackground('打包', async () => {
        await new Promise((r) => setTimeout(r, 10))
        return '完成输出'
      })
      await vi.waitFor(() => expect(backgroundNotifier?.list().length).toBe(1), { timeout: 3000 })
      const notif = n.list()[0]
      expect(notif.title).toContain('打包')
      expect(notif.message).toContain('完成输出')
    } finally {
      setBackgroundNotifier(null)
    }
  })

  test('startBackground announces failure', async () => {
    const n = new BackgroundNotifier()
    setBackgroundNotifier(n)
    try {
      startBackground('崩溃任务', async () => {
        throw new Error('boom')
      })
      await vi.waitFor(() => expect(n.list().length).toBe(1), { timeout: 3000 })
      expect(n.list()[0].message).toContain('boom')
    } finally {
      setBackgroundNotifier(null)
    }
  })

  test('BackgroundNotifier works with AnnouncementWindow gate', async () => {
    const win = new AnnouncementWindow()
    const n = new BackgroundNotifier({ window: win })
    win.beginTurn('t1') // 用户说话中
    n.addNotification('后台', '完成')
    expect(n.claimReady()).toBeNull()
    win.endSpeech()
    win.responseDone({ turnId: 't1' })
    expect(n.claimReady()?.message).toBe('完成')
  })
})