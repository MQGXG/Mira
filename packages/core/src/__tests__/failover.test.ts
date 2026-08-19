import { describe, expect, test, vi } from 'vitest'
import { FallbackClient } from '../orchestrate/failover'

type Event = { type: string; [key: string]: unknown }

vi.mock('../llm/client', () => ({
  createLLMClient: vi.fn((config: any) => {
    const provider = config.provider
    return {
      stream: vi.fn(async function* (_request: unknown): AsyncGenerator<Event> {
        if (provider === 'failing') {
          yield { type: 'delta', delta: 'partial' }
          yield { type: 'error', error: { message: 'rate limit exceeded 429' } }
          return
        }
        if (provider === 'conn-fail') {
          throw new Error('connection refused')
        }
        if (provider === 'auth-fail') {
          yield { type: 'error', error: { message: '401 unauthorized' } }
          return
        }
        yield { type: 'delta', delta: 'success' }
        yield { type: 'done' }
      }),
    }
  }),
}))

describe('FallbackClient', () => {
  test('主 provider 成功', async () => {
    const client = new FallbackClient({
      primary: { provider: 'openai', model: 'gpt-4', apiKey: 'key1' },
      fallbacks: [],
    })
    const events: Event[] = []
    for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(events.some(e => e.type === 'done')).toBe(true)
    expect(client.usedFallback).toBe(false)
  })

  test('429 降级到备用', async () => {
    const client = new FallbackClient({
      primary: { provider: 'failing', model: 'gpt-4', apiKey: 'key1' },
      fallbacks: [{ provider: 'openai', model: 'gpt-3.5', apiKey: 'key2' }],
    })
    const events: Event[] = []
    for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(client.usedFallback).toBe(true)
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  test('连接失败降级', async () => {
    const client = new FallbackClient({
      primary: { provider: 'conn-fail', model: 'gpt-4', apiKey: 'key1' },
      fallbacks: [{ provider: 'openai', model: 'gpt-3.5', apiKey: 'key2' }],
    })
    const events: Event[] = []
    for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(client.usedFallback).toBe(true)
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  test('auth 错误不降级', async () => {
    const client = new FallbackClient({
      primary: { provider: 'auth-fail', model: 'gpt-4', apiKey: 'key1' },
      fallbacks: [{ provider: 'openai', model: 'gpt-3.5', apiKey: 'key2' }],
    })
    const events: Event[] = []
    for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(client.usedFallback).toBe(false)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  test('全部 fallback 失败返回 error', async () => {
    const client = new FallbackClient({
      primary: { provider: 'failing', model: 'gpt-4', apiKey: 'key1' },
      fallbacks: [{ provider: 'failing', model: 'gpt-3.5', apiKey: 'key2' }],
    })
    const events: Event[] = []
    for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(client.usedFallback).toBe(true)
    const errors = events.filter(e => e.type === 'error')
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  test('无 fallback 失败返回 error', async () => {
    const client = new FallbackClient({
      primary: { provider: 'failing', model: 'gpt-4', apiKey: 'key1' },
      fallbacks: [],
    })
    const events: Event[] = []
    for await (const e of client.stream({ messages: [{ role: 'user', content: 'hi' }] })) events.push(e)
    expect(client.usedFallback).toBe(false)
    expect(events.some(e => e.type === 'error')).toBe(true)
  })
})
