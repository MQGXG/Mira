import { describe, expect, test } from 'vitest'
import { compactMessages, compactMessagesAsync } from '../session/compaction'

function makeMsg(role: string, content: string) {
  return { role: role as any, content }
}

describe('compactMessages', () => {
  test('returns unchanged when under budget', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => makeMsg('user', `msg ${i}`))
    const result = compactMessages(msgs, 100000)
    expect(result.level).toBe('none')
    expect(result.messages).toHaveLength(5)
  })

  test('applies L1 snip when level specified', () => {
    const msgs = Array.from({ length: 25 }, (_, i) => makeMsg('user', `message ${i} with some content`.repeat(10)))
    const result = compactMessages(msgs, 100, 'l1_snip')
    expect(result.level).toBe('l1_snip')
    expect(result.messages.length).toBeLessThan(25)
  })

  test('applies L2 micro when level specified', () => {
    const msgs = Array.from({ length: 15 }, (_, i) => makeMsg('tool', 'x'.repeat(5000)))
    const result = compactMessages(msgs, 100, 'l2_micro')
    expect(result.level).toBe('l2_micro')
  })

  test('applies L3 auto when level specified', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg('tool', 'x'.repeat(5000)))
    const result = compactMessages(msgs, 100, 'l3_auto')
    expect(result.level).toBe('l3_auto')
  })
})

describe('compactMessagesAsync', () => {
  test('returns unchanged when pressure is low', async () => {
    const msgs = Array.from({ length: 3 }, (_, i) => makeMsg('user', `msg ${i}`))
    const result = await compactMessagesAsync(msgs, { maxTokens: 100000 })
    expect(result).toHaveLength(3)
  })

  test('compacts when pressure is high', async () => {
    const msgs = Array.from({ length: 30 }, (_, i) => makeMsg('user', 'x'.repeat(200)))
    const result = await compactMessagesAsync(msgs, { maxTokens: 100 })
    expect(result.length).toBeLessThan(30)
  })
})
