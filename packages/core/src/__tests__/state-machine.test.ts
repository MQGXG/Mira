import { describe, expect, test } from 'vitest'
import { AgentStateMachine } from '../agent/state-machine'

describe('AgentStateMachine', () => {
  test('初始状态为 idle', () => {
    const sm = new AgentStateMachine()
    expect(sm.state).toBe('idle')
    expect(sm.aborted).toBe(false)
  })

  test('idle → running', () => {
    const sm = new AgentStateMachine()
    sm.start()
    expect(sm.state).toBe('running')
    expect(sm.aborted).toBe(false)
  })

  test('running → waiting_permission → running', () => {
    const sm = new AgentStateMachine()
    sm.start()
    sm.waitPermission()
    expect(sm.state).toBe('waiting_permission')
    sm.start()
    expect(sm.state).toBe('running')
  })

  test('running → stopped → aborted 为 true', () => {
    const sm = new AgentStateMachine()
    sm.start()
    sm.stop()
    expect(sm.state).toBe('stopped')
    expect(sm.aborted).toBe(true)
  })

  test('running → done → aborted 为 false', () => {
    const sm = new AgentStateMachine()
    sm.start()
    sm.finish()
    expect(sm.state).toBe('done')
    expect(sm.aborted).toBe(false)
  })

  test('无效转换抛异常', () => {
    const sm = new AgentStateMachine()
    // idle → waitPermission 无效
    expect(() => sm.waitPermission()).toThrow('Invalid state transition')
    // idle → done 无效
    expect(() => sm.finish()).toThrow('Invalid state transition')
  })

  test('done 状态后再调用 start 抛异常', () => {
    const sm = new AgentStateMachine()
    sm.start()
    sm.finish()
    expect(() => sm.start()).toThrow('Invalid state transition')
  })

  test('subscribe 收到状态变化通知', () => {
    const sm = new AgentStateMachine()
    const changes: Array<{ prev: string; next: string }> = []
    const unsub = sm.subscribe((prev, next) => changes.push({ prev, next }))

    sm.start()
    sm.waitPermission()

    expect(changes).toHaveLength(2)
    expect(changes[0]).toEqual({ prev: 'idle', next: 'running' })
    expect(changes[1]).toEqual({ prev: 'running', next: 'waiting_permission' })

    unsub()
    expect(changes).toHaveLength(2) // unsubscribe 后不再通知
  })

  test('subscribe 返回的 unsubscribe 可取消订阅', () => {
    const sm = new AgentStateMachine()
    let count = 0
    const unsub = sm.subscribe(() => count++)
    sm.start()
    expect(count).toBe(1)
    unsub()
    // start 不会触发通知（已取消订阅），但 start 只能从 idle→running 调用一次
    // 所以用 waitPermission 来验证
    sm.waitPermission()
    expect(count).toBe(1) // 取消了订阅，不再增加
  })

  test('createPermissionRequest 创建待处理的权限请求', async () => {
    const sm = new AgentStateMachine()
    const { id, waitForReply } = sm.createPermissionRequest()
    expect(id).toBeTruthy()
    expect(typeof waitForReply).toBe('function')
  })

  test('replyPermission - allow', async () => {
    const sm = new AgentStateMachine()
    const { id, waitForReply } = sm.createPermissionRequest()
    const replied = sm.replyPermission(id, 'allow')
    expect(replied).toBe(true)
    await expect(waitForReply()).resolves.toBe(true)
  })

  test('replyPermission - deny', async () => {
    const sm = new AgentStateMachine()
    const { id, waitForReply } = sm.createPermissionRequest()
    sm.replyPermission(id, 'deny')
    await expect(waitForReply()).resolves.toBe(false)
  })

  test('replyPermission - always', async () => {
    const sm = new AgentStateMachine()
    let alwaysCalled = false
    const { id, waitForReply } = sm.createPermissionRequest(() => { alwaysCalled = true })
    sm.replyPermission(id, 'always')
    await expect(waitForReply()).resolves.toBe(true)
    expect(alwaysCalled).toBe(true)
  })

  test('replyPermission 不存在的 id 返回 false', () => {
    const sm = new AgentStateMachine()
    expect(sm.replyPermission('nonexistent', 'allow')).toBe(false)
  })
})
