import { describe, expect, test } from 'vitest'
import { EnvSource, SourceManager, BaseSource, MemorySource, type SourceContext } from '../session/context-source'

function makeCtx(overrides?: Partial<SourceContext>): SourceContext {
  return {
    sessionID: 's1',
    workspace: '/test/workspace',
    ...overrides,
  }
}

describe('EnvSource 缓存稳定性', () => {
  test("generate 注入当天日期（Today's date），供 LLM 免工具回答时间问题", () => {
    const env = new EnvSource()
    const content = env.generate(makeCtx())
    expect(content).toMatch(/Today's date: \w{3} \w{3} \d{2} \d{4}/)
    expect(content).toContain('Working directory')
    expect(content).toContain('Platform')
  })

  test('fingerprint 同日内稳定（hash 含当天日期，每日仅变化一次）', () => {
    const env = new EnvSource()
    const a = env.fingerprint(makeCtx())
    const b = env.fingerprint(makeCtx())
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toMatch(/^env-.*-v1$/)
  })

  test('SourceManager 二次 build 字节一致（同日内内容静态）', async () => {
    const sm = new SourceManager('/test/workspace')
    sm.register(new BaseSource())
    sm.register(new EnvSource())
    const ctx = makeCtx()
    const first = await sm.build(ctx)
    const second = await sm.build(ctx)
    expect(first).toBe(second)
  })
})

describe('SourceManager buildSeparated（C1 分离）', () => {
  test('稳定 source 进 system，memory 进独立 context', async () => {
    const sm = new SourceManager('/test/workspace')
    const base = new BaseSource()
    sm.register(base)
    sm.register(new EnvSource())
    const mem = new MemorySource()
    mem.setMemoryContent('user prefers TypeScript')
    sm.register(mem)

    const result = await sm.buildSeparated(makeCtx())
    expect(result.system).toContain('Working directory')
    expect(result.system).not.toContain('TypeScript')
    expect(result.context).toContain('TypeScript')
    expect(result.context).toContain('Current runtime context.')
  })

  test('无动态 source 时 context 为空', async () => {
    const sm = new SourceManager('/test/workspace')
    sm.register(new BaseSource())
    sm.register(new EnvSource())
    const result = await sm.buildSeparated(makeCtx())
    expect(result.context).toBe('')
    expect(result.system.length).toBeGreaterThan(0)
  })
})
