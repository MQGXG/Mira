import { describe, expect, test } from 'vitest'
import { z } from 'zod/v4'
import { make, settle, sanitizeToolError, coerceToolArgs, RecoverableError, FatalError } from '../shared/tool'
import type { ToolContext, ToolCall } from '../shared/tool'

const mockCtx: ToolContext = {
  sessionID: 'test-session',
  workspace: '/test',
  mode: 'assistant',
  agent: 'default',
  assistantMessageID: 'msg-1',
  toolCallID: 'tc-1',
}

const echoTool = make({
  name: 'echo',
  description: '回声测试工具',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.string(),
  execute: async ({ text }) => ({ success: true, output: text }),
})

const calcTool = make({
  name: 'calc',
  description: '计算工具',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.string(),
  execute: async ({ a, b }) => ({ success: true, output: String(a + b) }),
})

const errorTool = make({
  name: 'error_maker',
  description: '始终失败的工具',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  execute: async () => { throw new Error('execution failed') },
})

const recoverableTool = make({
  name: 'recoverable',
  description: '可恢复错误工具',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  execute: async () => { throw new RecoverableError('bad input, retry') },
})

const fatalTool = make({
  name: 'fatal',
  description: '致命错误工具',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  execute: async () => { throw new FatalError('cannot recover') },
})

describe('make()', () => {
  test('创建工具定义', () => {
    expect(echoTool.name).toBe('echo')
    expect(echoTool.description).toBe('回声测试工具')
    expect(echoTool.execute).toBeDefined()
  })

  test('可添加可选字段', () => {
    const tool = make({
      name: 'readonly_test',
      description: 'test',
      inputSchema: z.object({}),
      outputSchema: z.string(),
      execute: async () => ({ success: true, output: '' }),
      isReadOnly: true,
      isConcurrencySafe: true,
      timeout: 5000,
    })
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.timeout).toBe(5000)
  })
})

describe('settle()', () => {
  test('成功执行', async () => {
    const call: ToolCall = { id: '1', name: 'echo', input: { text: 'hello' } }
    const { result, content } = await settle(echoTool, call, mockCtx)
    expect(result.success).toBe(true)
    expect(result.output).toBe('hello')
    expect(result.metadata?.elapsed).toBeGreaterThanOrEqual(0)
    expect(content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  test('参数类型协变（字符串→数字）', async () => {
    const call: ToolCall = { id: '2', name: 'calc', input: { a: '3', b: '4' } }
    const { result } = await settle(calcTool, call, mockCtx)
    expect(result.success).toBe(true)
    expect(result.output).toBe('7')
  })

  test('参数校验失败返回可恢复错误', async () => {
    const call: ToolCall = { id: '3', name: 'echo', input: {} }
    const { result, content } = await settle(echoTool, call, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid input')
    expect(result.metadata?.errorType).toBe('recoverable')
    expect((content[0] as { text?: string }).text).toContain('Invalid input')
  })

  test('输出截断', async () => {
    const longOutputTool = make({
      name: 'long_output',
      description: '输出很长的工具',
      inputSchema: z.object({}),
      outputSchema: z.string(),
      maxOutputLength: 20,
      execute: async () => ({ success: true, output: 'A'.repeat(100) }),
    })
    const call: ToolCall = { id: '4', name: 'long_output', input: {} }
    const { result } = await settle(longOutputTool, call, mockCtx)
    expect(result.output!.length).toBeLessThanOrEqual(20 + 50)
    expect(result.output).toContain('[Output truncated')
    expect(result.metadata?.truncated).toBe(true)
  })

  test('执行错误标记为普通错误', async () => {
    const call: ToolCall = { id: '5', name: 'error_maker', input: {} }
    const { result } = await settle(errorTool, call, mockCtx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('[TOOL_ERROR]')
    expect(result.error).toContain('execution failed')
    expect(result.metadata?.errorType).toBe('recoverable')
  })

  test('RecoverableError 标记为 recoverable', async () => {
    const call: ToolCall = { id: '6', name: 'recoverable', input: {} }
    const { result } = await settle(recoverableTool, call, mockCtx)
    expect(result.metadata?.errorType).toBe('recoverable')
  })

  test('FatalError 标记为 fatal', async () => {
    const call: ToolCall = { id: '7', name: 'fatal', input: {} }
    const { result } = await settle(fatalTool, call, mockCtx)
    expect(result.metadata?.errorType).toBe('fatal')
  })

  test('toModelOutput 被正确调用', async () => {
    const customTool = make({
      name: 'custom_out',
      description: '自定义输出',
      inputSchema: z.object({}),
      outputSchema: z.string(),
      execute: async () => ({ success: true, output: 'data' }),
      toModelOutput: (input, output) => [{ type: 'text', text: `processed: ${output}` }],
    })
    const call: ToolCall = { id: '8', name: 'custom_out', input: {} }
    const { content } = await settle(customTool, call, mockCtx)
    expect(content[0]).toEqual({ type: 'text', text: 'processed: data' })
  })
})

describe('sanitizeToolError', () => {
  test('移除 XML 标签', () => {
    expect(sanitizeToolError('<tool_call>error</tool_call>')).toBe('[TOOL_ERROR] error')
  })

  test('移除代码 fence', () => {
    const result = sanitizeToolError('```json\nerror\n```')
    expect(result).toContain('error')
    expect(result).not.toContain('```')
  })

  test('处理空字符串', () => {
    expect(sanitizeToolError('')).toBe('[TOOL_ERROR] ')
  })

  test('截断过长错误', () => {
    const long = 'x'.repeat(3000)
    const result = sanitizeToolError(long)
    expect(result.length).toBeLessThan(2500)
    expect(result).toContain('...')
  })
})

describe('coerceToolArgs', () => {
  test('字符串数字转 integer', () => {
    const out = coerceToolArgs('test', { n: '42' }, { properties: { n: { type: 'integer' } } })
    expect(out.n).toBe(42)
  })

  test('字符串数字转 number', () => {
    const out = coerceToolArgs('test', { n: '3.14' }, { properties: { n: { type: 'number' } } })
    expect(out.n).toBe(3.14)
  })

  test('字符串 true/false 转 boolean', () => {
    const out = coerceToolArgs('test', { a: 'true', b: 'false' }, { properties: { a: { type: 'boolean' }, b: { type: 'boolean' } } })
    expect(out.a).toBe(true)
    expect(out.b).toBe(false)
  })

  test('非字符串值不处理', () => {
    const out = coerceToolArgs('test', { n: 42, s: 'hello' }, { properties: { n: { type: 'integer' }, s: { type: 'string' } } })
    expect(out.n).toBe(42)
    expect(out.s).toBe('hello')
  })
})
