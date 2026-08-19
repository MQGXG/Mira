import { describe, expect, test } from 'vitest'
import { serializeMessages } from '../llm/protocols/openai-chat'
import { sanitizeMessagesForLLM } from '../shared/message-utils'

describe('reasoning_content 回传（DeepSeek thinking 模式）', () => {
  test('assistant 消息带 reasoning_content 时序列化会回传', () => {
    const out = serializeMessages([
      { role: 'assistant', content: '你好', reasoning_content: '这是思考过程' },
    ])
    expect(out[0].reasoning_content).toBe('这是思考过程')
    expect(out[0].content).toBe('你好')
  })

  test('assistant 消息的 reasoning part 会合并为 reasoning_content', () => {
    const out = serializeMessages([
      { role: 'assistant', content: [{ type: 'reasoning', text: '思考中' }, { type: 'text', text: '回答' }] },
    ])
    expect(out[0].reasoning_content).toBe('思考中')
    expect(out[0].content).toBe('回答')
  })

  test('空 assistant 消息（无内容无 tool_calls 无 reasoning）被过滤，避免 DeepSeek 400', () => {
    const out = serializeMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [] },
    ])
    expect(out.length).toBe(1)
    expect(out[0].role).toBe('user')
  })

  test('纯 reasoning assistant 保留（有 reasoning_content 则 content 用空串）', () => {
    const out = serializeMessages([
      { role: 'assistant', content: [{ type: 'reasoning', text: '思考' }] },
    ])
    expect(out[0].reasoning_content).toBe('思考')
    expect(out[0].content).toBe('')
  })

  test('sanitize 后 reasoning_content 保留（历史工具调用场景）', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: 'tc1', toolName: 'web_search', args: { q: 'news' } }], reasoning_content: '先搜索' },
    ]
    const sanitized = sanitizeMessagesForLLM(messages)
    const assistant = sanitized.find(m => m.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('先搜索')
  })
})
