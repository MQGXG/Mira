import { describe, expect, test, vi } from 'vitest'
import { Agent } from '../agent/agent'
import { ToolRegistry } from '../system/registry'
import { make } from '../shared/tool'
import { z } from 'zod/v4'
import { loadSession, appendMessage } from '../session/store'
import { createLLMClient } from '../llm/client'
import { initPlatformPaths, getPlatformPaths } from '../config/paths'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('../llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/client')>()
  return {
    ...actual,
    createLLMClient: vi.fn().mockImplementation(() => ({
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: 'delta' as const, delta: 'Hello from agent' }
        yield { type: 'done' as const }
      }),
      complete: vi.fn().mockImplementation(async () => ({ content: '0' })),
    })),
  }
})

const echoTool = make({
  name: 'echo',
  description: '回声工具',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.string(),
  execute: async ({ text }) => ({ success: true, output: text }),
})

describe('Agent', () => {
  test('使用注册表初始化', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const agent = new Agent(registry)
    expect(agent).toBeDefined()
  })

  test('abort 将状态机置为 stopped', () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    expect(agent.aborted).toBe(false)
    agent.abort()
    expect(agent.aborted).toBe(true)
  })

  test('replyPermission 传递到状态机', () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    agent.replyPermission('nonexistent', 'allow') // 应静默处理
  })

  test('getGoalJudge 返回 goalJudge 实例', () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    expect(agent.getGoalJudge()).toBeDefined()
  })

  test('getContextManager 返回 contextManager 实例', () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    expect(agent.getContextManager()).toBeDefined()
  })

  test('无 workspace 时 getSourceManager 返回 null', () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    expect(agent.getSourceManager()).toBeNull()
  })

  test('构造函数接受 deps 注入', () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry, undefined, undefined, undefined, {
      // 使用空 deps 验证注入路径
    })
    expect(agent).toBeDefined()
    expect(agent.getContextManager()).toBeDefined()
  })

  test('多次 abort 安全', () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    agent.abort()
    agent.abort() // 第二次不应抛异常
    expect(agent.aborted).toBe(true)
  })

  test('persists pure-text assistant reply to session', async () => {
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    const config = {
      sessionID: 'c1-test',
      workspace: '/tmp',
      model: 'gpt-4',
      apiKey: 'k',
      apiUrl: 'http://x',
    }
    for await (const _e of agent.run('hi', [], config)) {}
    const stored = await loadSession('c1-test')
    const assistant = stored?.messages.filter((m) => m.role === 'assistant')
    expect(assistant?.some((m) => m.content.includes('Hello from agent'))).toBe(true)
  })

  // ── 历史图片按模型视觉能力分流（修复"没问却复述上一张图"）──────────────

  /** 写入一条含图片的用户消息，并用 mock 客户端捕获实际发给 LLM 的消息 */
  async function runWithHistoricalImage(modelVision: boolean | undefined) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-agent-img-'))
    const prev = getPlatformPaths()
    initPlatformPaths({ userData: tmp })

    const sid = `img-split-${Date.now()}`
    const attDir = path.join(tmp, 'attachments', sid)
    fs.mkdirSync(attDir, { recursive: true })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    fs.writeFileSync(path.join(attDir, '1.png'), png)
    await appendMessage(sid, {
      role: 'user',
      content: JSON.stringify({ text: '看看这张图', images: [`attachments/${sid}/1.png`] }),
      timestamp: new Date().toISOString(),
    })

    let captured: unknown = null
    vi.mocked(createLLMClient).mockImplementationOnce(() => ({
      stream: vi.fn().mockImplementation(async function* (req: { messages: unknown[] }) {
        if (!captured) captured = req.messages
        yield { type: 'delta' as const, delta: 'ok' }
        yield { type: 'done' as const }
      }),
      complete: vi.fn().mockImplementation(async () => ({ content: '0' })),
    }))

    const registry = new ToolRegistry()
    registry.register(echoTool)
    const agent = new Agent(registry)
    const config = {
      sessionID: sid,
      workspace: tmp,
      model: 'gpt-4',
      apiKey: 'k',
      apiUrl: 'http://x',
      modelVision,
    }
    for await (const _e of agent.run('继续', [], config)) { if (!_e) break }
    initPlatformPaths(prev)
    return captured as { content: Array<{ type: string }> }[] | null
  }

  function findHistoricalUserMsg(messages: { content: Array<{ type: string }> }[] | null) {
    return messages?.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((c) => typeof c === 'object' && 'text' in c && (c as { text: string }).text.includes('看看这张图'))
    )
  }

  test('非视觉模型：历史图片转为文本占位（不触发桥重描述）', async () => {
    const messages = await runWithHistoricalImage(undefined)
    const userMsg = findHistoricalUserMsg(messages)
    expect(userMsg).toBeDefined()
    const parts = userMsg!.content as Array<{ type: string; text?: string; image?: string }>
    expect(parts.some((p) => p.type === 'image')).toBe(false)
    expect(parts.some((p) => p.type === 'text' && p.text?.includes('read_file 查看附件'))).toBe(true)
  })

  test('全模态模型：历史图片保留为 ImagePart 直发', async () => {
    const messages = await runWithHistoricalImage(true)
    const userMsg = findHistoricalUserMsg(messages)
    expect(userMsg).toBeDefined()
    const parts = userMsg!.content as Array<{ type: string; text?: string; image?: string }>
    expect(parts.some((p) => p.type === 'image')).toBe(true)
  })
})
