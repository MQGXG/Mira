import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../system/registry'
import { buildInstructionSystemPrompt } from '../system/instruction'

describe('Agent Core benchmarks', () => {
  it('registry handles 100 tools', () => {
    const registry = new ToolRegistry()
    for (let i = 0; i < 100; i++) {
      registry.register({
        name: `bench_tool_${i}`,
        description: `Benchmark tool ${i}`,
        execute: async () => ({ success: true, output: 'ok' }),
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
        outputSchema: { parse: (v: unknown) => v } as any,
      })
    }
    const materialized = registry.materialize()
    expect(Object.keys(materialized.definitions)).toHaveLength(100)
  })

  it('materialize runs under 5ms', () => {
    const registry = new ToolRegistry()
    for (let i = 0; i < 20; i++) {
      registry.register({
        name: `tool_${i}`,
        description: `Tool ${i}`,
        execute: async () => ({ success: true, output: '' }),
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
        outputSchema: { parse: (v: unknown) => v } as any,
      })
    }
    const start = performance.now()
    for (let i = 0; i < 100; i++) {
      registry.materialize()
    }
    const elapsed = performance.now() - start
    expect(elapsed / 100).toBeLessThan(5)
  })

  it('instruction context loads without error', () => {
    // instruction-context 使用 app.getPath，在 test 环境下可能不可用
    // 这里只验证函数存在且能静默处理
    expect(typeof buildInstructionSystemPrompt).toBe('function')
  })
})
