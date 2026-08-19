import { describe, expect, test, vi } from 'vitest'
import {
  MemoryExtractor,
  createExtractorLlmCall,
  parseOps,
  cleanFact,
  transcriptLines,
  containsSensitiveContent,
  runSessionMemoryExtraction,
  setSessionMemoryExtractor,
} from '../memory/memory-extractor'

function makeStore() {
  const written: Array<{ content: string; sessionID: string; source: string }> = []
  const existing: Array<{ content: string }> = []
  return {
    written,
    store: {
      list: () => existing.map((e) => ({ content: e.content })),
      remember: (content: string, sessionID: string, source = 'inferred') => {
        written.push({ content, sessionID, source })
        existing.push({ content })
      },
    },
  }
}

const messages = [
  { role: 'user', content: '我是小李，我喜欢喝美式咖啡' },
  { role: 'assistant', content: '好的，记住了。' },
  { role: 'user', content: '我每天都会跑步半小时' },
  { role: 'assistant', content: '很棒的习惯。' },
  { role: 'user', content: '我明天要去开会' },
  { role: 'assistant', content: '好的。' },
]

describe('MemoryExtractor', () => {
  test('writes structured memories with type prefix', async () => {
    const { written, store } = makeStore()
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => JSON.stringify({
        ops: [
          { action: 'add', kind: 'stated', type: 'persona', priority: 80, content: '用户喜欢喝美式咖啡' },
          { action: 'add', kind: 'stated', type: 'instruction', priority: 90, content: '用户要求 AI 回答时先给出结论' },
        ],
      }),
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(2)
    expect(written[0].content).toBe('[persona] 用户喜欢喝美式咖啡')
    expect(written[1].content).toBe('[instruction] 用户要求 AI 回答时先给出结论')
  })

  test('writes stated facts tagged inferred', async () => {
    const { written, store } = makeStore()
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => JSON.stringify({
        ops: [
          { action: 'add', kind: 'stated', content: '用户喜欢喝美式咖啡' },
          { action: 'add', kind: 'stated', content: '用户每天跑步半小时' },
          { action: 'add', kind: 'inferred', content: '用户可能工作很忙' },
          { action: 'skip', kind: 'stated', content: '用户只是临时问问' },
        ],
      }),
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(2)
    expect(written[0].source).toBe('inferred')
    expect(written.map((w) => w.content)).toContain('用户喜欢喝美式咖啡')
    expect(written.map((w) => w.content)).toContain('用户每天跑步半小时')
  })

  test('keepInferred option preserves inferred facts', async () => {
    const { written, store } = makeStore()
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      keepInferred: true,
      llmCall: () => JSON.stringify({
        ops: [
          { action: 'add', kind: 'stated', content: '用户喜欢读书' },
          { action: 'add', kind: 'inferred', content: '用户可能工作很忙' },
          { action: 'add', kind: 'inferred', content: '用户可能经常加班' },
        ],
      }),
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(3)
    expect(written.map((w) => w.content)).toContain('用户可能工作很忙')
    expect(written.map((w) => w.content)).toContain('用户可能经常加班')
  })

  test('never persists sensitive content', async () => {
    const { written, store } = makeStore()
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => JSON.stringify({
        ops: [
          { action: 'add', kind: 'stated', content: '用户的 API 密钥是 sk-abc123def456' },
          { action: 'add', kind: 'stated', content: '用户喜欢猫' },
        ],
      }),
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(1)
    expect(written[0].content).toBe('用户喜欢猫')
  })

  test('skips duplicates against existing memory', async () => {
    const { written, store } = makeStore()
    store.list = () => [{ content: '用户喜欢喝美式咖啡' }]
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => JSON.stringify({
        ops: [
          { action: 'add', kind: 'stated', content: '用户喜欢喝美式咖啡' },
          { action: 'add', kind: 'stated', content: '用户喜欢读书' },
        ],
      }),
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(1)
    expect(written[0].content).toBe('用户喜欢读书')
  })

  test('empty ops writes nothing', async () => {
    const { written, store } = makeStore()
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => '{"ops":[]}',
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(0)
  })

  test('caps at MAX_OPS_PER_RUN (5)', async () => {
    const { written, store } = makeStore()
    const ops = Array.from({ length: 10 }, (_, i) => ({
      action: 'add', kind: 'stated', content: `用户习惯${i}`,
    }))
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => JSON.stringify({ ops }),
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(5)
  })

  test('parse failure is silent and writes nothing', async () => {
    const { written, store } = makeStore()
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => 'not json at all',
      logger: { debug: vi.fn() },
    })
    await extractor.run({ sessionID: 's1', messages })
    expect(written).toHaveLength(0)
  })

  test('maybeRun respects minUserMessages gate', async () => {
    const { store } = makeStore()
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => [{ role: 'user', content: 'hi' }],
      llmCall: () => '{"ops":[]}',
      minUserMessages: 4,
    })
    expect(await extractor.maybeRun('s1')).toBeNull()
  })

  test('maybeRun debounces per session', async () => {
    const { store } = makeStore()
    let now = 0
    const extractor = new MemoryExtractor({
      store,
      listMessages: () => messages,
      llmCall: () => '{"ops":[]}',
      minUserMessages: 1,
      now: () => now,
      debounceMs: 1000,
    })
    expect(await extractor.maybeRun('s1')).not.toBeNull()
    now = 500
    expect(await extractor.maybeRun('s1')).toBeNull()
    now = 2000
    expect(await extractor.maybeRun('s1')).not.toBeNull()
  })

  test('enabled() false without llmCall', () => {
    const { store } = makeStore()
    const extractor = new MemoryExtractor({ store, listMessages: () => [], llmCall: null })
    expect(extractor.enabled()).toBe(false)
  })

  test('run() never rejects on store failure', async () => {
    const { store } = makeStore()
    const failStore = {
      ...store,
      remember: () => { throw new Error('disk full') },
    }
    const extractor = new MemoryExtractor({
      store: failStore,
      listMessages: () => messages,
      llmCall: () => JSON.stringify({ ops: [{ action: 'add', kind: 'stated', content: 'x' }] }),
    })
    await expect(extractor.run({ sessionID: 's1', messages })).resolves.toBeUndefined()
  })
})

describe('parseOps / cleanFact / transcriptLines', () => {
  test('strips markdown code fences', () => {
    const ops = parseOps('```json\n{"ops":[{"action":"add","kind":"stated","content":"x"}]}\n```')
    expect(ops).toHaveLength(1)
    expect(ops[0].content).toBe('x')
  })

  test('cleanFact trims and caps length', () => {
    expect(cleanFact('  用户喜欢  猫  ')).toBe('用户喜欢 猫')
    const long = 'x'.repeat(200)
    expect(cleanFact(long)).toHaveLength(100)
  })

  test('transcriptLines keeps recent turns under budget', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: `msg${i}` }))
    const lines = transcriptLines(msgs, 30)
    expect(lines.length).toBeLessThan(5)
    expect(lines[lines.length - 1]).toBe('用户: msg4')
    expect(lines[0]).toBe('用户: msg2')
  })

  test('containsSensitiveContent detects secrets', () => {
    expect(containsSensitiveContent('我的密码是 123456')).toBe(true)
    expect(containsSensitiveContent('用户喜欢咖啡')).toBe(false)
    expect(containsSensitiveContent('token 是 abc')).toBe(true)
  })
})

describe('createExtractorLlmCall', () => {
  test('returns null without apiKey', async () => {
    expect(await createExtractorLlmCall({ provider: 'openai', model: 'm', apiKey: '' })).toBeNull()
  })
})

describe('runSessionMemoryExtraction', () => {
  test('short-circuits when no global extractor configured', () => {
    setSessionMemoryExtractor(null)
    expect(runSessionMemoryExtraction('s1')).toBeNull()
  })
})