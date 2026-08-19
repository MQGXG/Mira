import { describe, expect, test } from 'vitest'
import { MemoryManager } from '../memory/manager'
import type { MemoryProvider } from '../memory/types'
import { BuiltinMemoryProvider } from '../memory/builtin-provider'

function createMockProvider(name: string): MemoryProvider {
  return {
    name,
    initialize: async () => {},
    buildSystemPrompt: () => `[${name} prompt]`,
    prefetch: async () => `${name}:prefetched`,
    syncTurn: async () => {},
    shutdown: async () => {},
  }
}

describe('MemoryManager', () => {
  test('新建管理器无 Provider', () => {
    const m = new MemoryManager()
    expect(m.getFTSProvider()).toBeNull()
    expect(m.getBuiltinProvider()).toBeNull()
  })

  test('addProvider 注册 Provider', () => {
    const m = new MemoryManager()
    const p = createMockProvider('test')
    m.addProvider(p)
    expect(m.getFTSProvider()).toBeNull()
    expect(m.getBuiltinProvider()).toBeNull()
  })

  test('getFTSProvider 按名称查找', () => {
    const m = new MemoryManager()
    const fts = createMockProvider('fts-memory')
    m.addProvider(fts)
    const found = m.getFTSProvider()
    expect(found).toBeDefined()
    expect(found!.name).toBe('fts-memory')
  })

  test('buildSystemPrompt 聚合所有 Provider', () => {
    const m = new MemoryManager()
    m.addProvider(createMockProvider('a'))
    m.addProvider(createMockProvider('b'))
    m.addProvider(createMockProvider('c'))
    const prompt = m.buildSystemPrompt()
    expect(prompt).toContain('[a prompt]')
    expect(prompt).toContain('[b prompt]')
    expect(prompt).toContain('[c prompt]')
  })

  test('initialize 初始化所有 Provider', async () => {
    const m = new MemoryManager()
    let initCount = 0
    m.addProvider({
      name: 'test',
      initialize: async () => { initCount++ },
      buildSystemPrompt: () => '',
      prefetch: async () => '',
      syncTurn: async () => {},
      shutdown: async () => {},
    })
    await m.initialize('sess-1', '/ws')
    expect(initCount).toBe(1)
  })

  test('shutdown 关闭所有 Provider', async () => {
    const m = new MemoryManager()
    let shutdownCount = 0
    m.addProvider({
      name: 'test',
      initialize: async () => {},
      buildSystemPrompt: () => '',
      prefetch: async () => '',
      syncTurn: async () => {},
      shutdown: async () => { shutdownCount++ },
    })
    await m.shutdown()
    expect(shutdownCount).toBe(1)
  })

  test('syncTurn 推送并触发 batch flush', async () => {
    const m = new MemoryManager()
    const turns: Array<{ user: string; assistant: string }> = []
    m.addProvider({
      name: 'test',
      initialize: async () => {},
      buildSystemPrompt: () => '',
      prefetch: async () => '',
      syncTurn: async (user, assistant) => { turns.push({ user, assistant }) },
      shutdown: async () => {},
    })

    await m.syncTurn('hello', 'world', 'sess-1')
    await m.syncTurn('foo', 'bar', 'sess-1')
    await m.syncTurn('hi', 'there', 'sess-1')

    // batch 3 → 自动 flush
    expect(turns.length).toBeGreaterThanOrEqual(3)
  })

  test('syncTurn 不触发 flush 不到 batch 数', async () => {
    const m = new MemoryManager()
    const turns: Array<{ user: string; assistant: string }> = []
    m.addProvider({
      name: 'test',
      initialize: async () => {},
      buildSystemPrompt: () => '',
      prefetch: async () => '',
      syncTurn: async (user, assistant) => { turns.push({ user, assistant }) },
      shutdown: async () => {},
    })

    await m.syncTurn('only one', 'turn', 'sess-1')
    expect(turns.length).toBe(0) // batch 未满，不 flush
  })

  test('BuiltinMemoryProvider 可集成', async () => {
    const m = new MemoryManager()
    const builtin = new BuiltinMemoryProvider()
    m.addProvider(builtin)
    await m.initialize('test-session', '/ws')

    expect(m.getBuiltinProvider()).toBeDefined()
    const prompt = m.buildSystemPrompt()
    expect(typeof prompt).toBe('string')
  })
})
