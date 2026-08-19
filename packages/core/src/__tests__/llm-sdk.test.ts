import { describe, expect, test, vi } from 'vitest'
import { createLLMClient } from '../llm/client'
import { ProviderCatalog } from '../llm/provider-catalog'

describe('createLLMClient', () => {
  test('creates OpenAI client', () => {
    const client = createLLMClient({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
    })
    expect(client).toBeDefined()
    expect(typeof client.stream).toBe('function')
    expect(typeof client.complete).toBe('function')
  })

  test('creates Anthropic client', () => {
    const client = createLLMClient({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'test-key',
      apiUrl: 'https://api.anthropic.com',
    })
    expect(client).toBeDefined()
    expect(typeof client.stream).toBe('function')
    expect(typeof client.complete).toBe('function')
  })

  test('creates custom provider client', () => {
    const client = createLLMClient({
      provider: 'custom',
      model: 'qwen2.5',
      apiKey: 'x',
      apiUrl: 'http://localhost:11434',
    })
    expect(client).toBeDefined()
    expect(typeof client.stream).toBe('function')
    expect(typeof client.complete).toBe('function')
  })

  test('does not replay partial output when stream errors mid-way', async () => {
    let attempts = 0
    const fakeRoute = {
      name: 'fake-route',
      protocol: { name: 'fake', serializeRequest: () => ({}), deserializeEvent: () => null },
      framing: 'sse',
      endpoint: { baseUrl: 'http://fake.local', path: '/v1' },
      auth: { type: 'bearer' as const, token: 'x' },
      headers: {},
      timeout: undefined,
      stream: vi.fn().mockImplementation(async function* () {
        attempts++
        if (attempts === 1) {
          // 第一次流输出一部分后抛 5xx 错误（模拟网络中断）
          yield { type: 'text-delta', delta: 'Partial ' }
          yield { type: 'error', message: 'HTTP 503 Service Unavailable' }
          return
        }
        yield { type: 'text-delta', delta: 'Full ' }
        yield { type: 'text-delta', delta: 'response' }
        yield { type: 'finish', reason: 'stop' }
      }),
      complete: async () => ({ content: '', toolCalls: [] }),
      with: () => fakeRoute,
    }

    vi.spyOn(ProviderCatalog, 'createRoute').mockReturnValue(fakeRoute as never)
    try {
      const client = createLLMClient({ provider: 'custom', model: 'm', apiKey: 'x', apiUrl: 'http://fake.local' })
      const deltas: string[] = []
      const retries: number[] = []
      const errors: string[] = []
      for await (const event of client.stream({ messages: [] })) {
        if (event.type === 'delta') deltas.push(event.delta)
        if (event.type === 'retry') retries.push(event.attempt)
        if (event.type === 'error') errors.push(event.error.message)
      }
      // 已吐出的部分输出不应在重试后被重复送达，也不应继续重试（重试会重复前半段）
      expect(deltas.join('')).toBe('Partial ')
      expect(retries).toHaveLength(0)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('503')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

