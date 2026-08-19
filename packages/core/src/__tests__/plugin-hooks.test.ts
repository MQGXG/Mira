import { describe, expect, test, vi } from 'vitest'
import { PluginHooks } from '../shared/plugin-hooks'

describe('PluginHooks', () => {
  test('emit fires handlers synchronously', () => {
    const hooks = new PluginHooks()
    const handler = vi.fn()
    hooks.on('test', handler)
    hooks.emit('test', 'arg1')
    expect(handler).toHaveBeenCalledWith('arg1')
  })

  test('emitAsync fires handlers in parallel', async () => {
    const hooks = new PluginHooks()
    const order: number[] = []
    hooks.on('test', async () => { await new Promise(r => setTimeout(r, 10)); order.push(1) })
    hooks.on('test', async () => { order.push(2) })
    await hooks.emitAsync('test')
    expect(order).toContain(1)
    expect(order).toContain(2)
  })

  test('triggerUntil stops at first non-null result', async () => {
    const hooks = new PluginHooks()
    hooks.on('test', () => null)
    hooks.on('test', () => 'blocked')
    hooks.on('test', () => 'should not run')
    const result = await hooks.triggerUntil('test')
    expect(result).toBe('blocked')
  })

  test('emitWaterfall chains results', async () => {
    const hooks = new PluginHooks()
    hooks.on('test', (val: string) => val + '-a')
    hooks.on('test', (val: string) => val + '-b')
    const result = await hooks.emitWaterfall('test', 'start')
    expect(result).toBe('start-a-b')
  })

  test('session_start hook fires', () => {
    const hooks = new PluginHooks()
    const handler = vi.fn()
    hooks.on('session_start', handler)
    hooks.emit('session_start', { sessionID: '123', workspace: '/tmp' })
    expect(handler).toHaveBeenCalledWith({ sessionID: '123', workspace: '/tmp' })
  })

  test('session_end hook fires', () => {
    const hooks = new PluginHooks()
    const handler = vi.fn()
    hooks.on('session_end', handler)
    hooks.emit('session_end', { sessionID: '123', workspace: '/tmp' })
    expect(handler).toHaveBeenCalled()
  })

  test('user_prompt_submit hook fires', () => {
    const hooks = new PluginHooks()
    const handler = vi.fn()
    hooks.on('user_prompt_submit', handler)
    hooks.emit('user_prompt_submit', { sessionID: '123', message: 'hello' })
    expect(handler).toHaveBeenCalledWith({ sessionID: '123', message: 'hello' })
  })

  test('post_tool_use hook fires', async () => {
    const hooks = new PluginHooks()
    const handler = vi.fn()
    hooks.on('post_tool_use', handler)
    await hooks.emitAsync('post_tool_use', [{ id: '1', name: 'bash' }], new Map([['1', { success: true }]]))
    expect(handler).toHaveBeenCalled()
  })

  test('pre_tool_execute waterfall can rewrite tool arguments', async () => {
    const hooks = new PluginHooks()
    hooks.on('pre_tool_execute', (tc: { id: string; name: string; arguments: string }) => ({
      ...tc,
      arguments: JSON.stringify({ ...JSON.parse(tc.arguments), command: 'echo safe' }),
    }))
    const input = { id: '1', name: 'bash', arguments: '{"command":"rm -rf /"}' }
    const result = await hooks.emitWaterfall('pre_tool_execute', input, {})
    expect(JSON.parse(result.arguments).command).toBe('echo safe')
  })

  test('pre_llm waterfall chains message transformations', async () => {
    const hooks = new PluginHooks()
    hooks.on('pre_llm', (msgs: any[]) => [...msgs, { role: 'user', content: 'injected' }])
    const result = await hooks.emitWaterfall('pre_llm', [{ role: 'user', content: 'hi' }], {})
    expect(result).toHaveLength(2)
    expect(result[1].content).toBe('injected')
  })

  test('on returns unsubscribe function', () => {
    const hooks = new PluginHooks()
    const handler = vi.fn()
    const unsub = hooks.on('test', handler)
    hooks.emit('test')
    expect(handler).toHaveBeenCalledTimes(1)
    unsub()
    hooks.emit('test')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('listenerCount returns correct count', () => {
    const hooks = new PluginHooks()
    hooks.on('test', () => {})
    hooks.on('test', () => {})
    expect(hooks.listenerCount('test')).toBe(2)
    expect(hooks.listenerCount('other')).toBe(0)
  })
})
