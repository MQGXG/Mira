import { describe, expect, test } from 'vitest'
import { repairMessageSequence, estimateTokens, truncateToBudget, sanitizeMessagesForLLM, estimateTextTokens } from '../shared/message-utils'

describe('repairMessageSequence', () => {
  test('tool 后缺少 assistant 时自动补充', () => {
    const out = repairMessageSequence([
      { role: 'tool', content: 'x', tool_call_id: '1' },
      { role: 'user', content: 'y' },
    ])
    expect(out[out.length - 1].role).toBe('user')
    expect(out[out.length - 2].role).toBe('assistant')
  })

  test('连续的 tool 消息被保留（前面会被补充 assistant 消息）', () => {
    const out = repairMessageSequence([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: '1', toolName: 'echo', args: {} }] },
      { role: 'tool', content: 'r1', tool_call_id: '1' },
      { role: 'tool', content: 'r2', tool_call_id: '1' },
    ])
    // 修复器可能会增加 assistant 包装，但原始 tool 消息应保留
    const toolCount = out.filter(m => m.role === 'tool').length
    expect(toolCount).toBeGreaterThanOrEqual(2)
  })

  test('空数组返回空', () => {
    expect(repairMessageSequence([])).toEqual([])
  })

  test('孤立 tool（tool_call_id 未声明）转为文本附加到上一条', () => {
    const out = repairMessageSequence([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result-data', tool_call_id: 'orphan-1' },
    ])
    // 孤立 tool 不应保留为 tool 角色，应转为文本（避免 API 400）
    expect(out.filter(m => m.role === 'tool').length).toBe(0)
    expect(typeof out[out.length - 1].content).toBe('string')
    expect(String(out[out.length - 1].content)).toContain('result-data')
  })

  test('乱序 [user, tool, assistant(tool_calls)] 修复为合法序列', () => {
    const out = repairMessageSequence([
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'r', tool_call_id: 'tc-1' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'echo', args: {} }] },
    ])
    // 孤立 tool 被转文本，assistant 保留 tool-call
    expect(out.filter(m => m.role === 'tool').length).toBe(0)
    const assistant = out.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()
  })
})

describe('sanitizeMessagesForLLM', () => {
  test('为缺失结果的 tool-call 补 error 结果', () => {
    const out = sanitizeMessagesForLLM([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'echo', args: { x: 1 } }] },
    ])
    const toolMsg = out.find(m => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_call_id).toBe('tc-1')
    const content = Array.isArray(toolMsg!.content)
      ? String((toolMsg!.content as any)[0]?.output || '')
      : String(toolMsg!.content)
    expect(content).toContain('interrupted')
  })

  test('已有结果的 tool-call 不重复补', () => {
    const out = sanitizeMessagesForLLM([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'echo', args: {} }] },
      { role: 'tool', content: 'done', tool_call_id: 'tc-1' },
    ])
    const tools = out.filter(m => m.role === 'tool')
    expect(tools.length).toBe(1)
    const content = Array.isArray(tools[0].content)
      ? (tools[0].content as any)[0]?.output
      : tools[0].content
    expect(content).toBe('done')
  })

  test('干净序列保持不变（以 user 结尾）', () => {
    const input = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
      { role: 'user' as const, content: '继续' },
    ]
    const out = sanitizeMessagesForLLM(input)
    expect(out).toEqual(input)
  })

  test('以 assistant 结尾时自动追加 Continue user 消息（prefill 400 防护）', () => {
    const input = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ]
    const out = sanitizeMessagesForLLM(input)
    expect(out.length).toBe(3)
    expect(out[out.length - 1].role).toBe('user')
    expect(out[out.length - 1].content).toBe('Continue.')
  })
})

describe('estimateTokens', () => {
  test('空消息返回 0', () => {
    expect(estimateTokens([])).toBe(0)
  })

  test('估算字符串消息', () => {
    const tokens = estimateTokens([{ role: 'user', content: 'hello world' }])
    expect(tokens).toBeGreaterThan(0)
  })

  test('估算包含 Part 数组的消息', () => {
    const tokens = estimateTokens([{
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool-call', toolCallId: '1', toolName: 'echo', args: { text: 'world' } },
      ],
    }])
    expect(tokens).toBeGreaterThan(0)
  })

  test('中文估算按 0.6 token/字（对齐 DeepSeek 官方换算）', () => {
    const zh = '今天国内有什么有趣的新闻？请帮我搜索一下最新的科技资讯。'
    const estimated = estimateTextTokens(zh)
    // DeepSeek 官方：1 中文字 ≈ 0.6 token
    const official = Math.round(zh.length * 0.6)
    // 允许 ±2 误差（含少量标点）
    expect(Math.abs(estimated - official)).toBeLessThanOrEqual(2)
    // 中文应显著高于旧的 /4 估算（旧法低估）
    expect(estimated).toBeGreaterThan(Math.ceil(zh.length / 4) + 5)
  })

  test('英文估算按 0.3 token/字', () => {
    const en = 'hello world this is a test'
    const estimated = estimateTextTokens(en)
    const expected = Math.round(en.length * 0.3)
    expect(Math.abs(estimated - expected)).toBeLessThanOrEqual(2)
  })
})

describe('truncateToBudget', () => {
  test('保留最新消息', () => {
    const messages = [
      { role: 'system' as const, content: 'system' },
      { role: 'user' as const, content: 'a'.repeat(4000) },
      { role: 'assistant' as const, content: 'b'.repeat(4000) },
      { role: 'user' as const, content: 'current' },
    ]
    const out = truncateToBudget(messages, 500)
    expect(out.some(m => m.content === 'current')).toBe(true)
  })

  test('system 消息始终保留', () => {
    const messages = [
      { role: 'system' as const, content: 'you are helpful' },
      { role: 'user' as const, content: 'a'.repeat(10000) },
    ]
    const out = truncateToBudget(messages, 100)
    expect(out.some(m => m.role === 'system')).toBe(true)
  })

  test('余额充足时不截断', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
    ]
    const out = truncateToBudget(messages, 100000)
    expect(out.length).toBe(2)
  })
})
