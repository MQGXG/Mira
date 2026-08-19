import { describe, expect, test, vi } from 'vitest'
import { Agent } from '../agent/agent'
import { ToolRegistry } from '../system/registry'
import { make } from '../shared/tool'
import { PermissionSet, checkHardDeny } from '../system/permission'
import { evaluateToolCalls } from '../system/permission/gate'
import { z } from 'zod'
import type { AgentEvent } from '../types'

const mockState = vi.hoisted(() => ({
  toolCall: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) },
  streamCount: 0,
}))

vi.mock('../llm/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/client')>()
  return {
    ...actual,
    createLLMClient: vi.fn().mockImplementation(() => ({
      stream: vi.fn().mockImplementation(async function* () {
        mockState.streamCount++
        if (mockState.streamCount === 1 && mockState.toolCall) {
          yield {
            type: 'tool_call',
            toolCall: { id: 'tc-1', ...mockState.toolCall, index: 0 },
          }
        }
        yield { type: 'done' }
      }),
      complete: vi.fn().mockResolvedValue({ content: '0' }),
    })),
  }
})

function resetMock(): void {
  mockState.streamCount = 0
  mockState.toolCall = { name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) }
}

const bashTool = make({
  name: 'bash',
  description: 'run shell command',
  inputSchema: z.object({ command: z.string() }),
  outputSchema: z.string(),
  execute: async ({ command }) => ({ success: true, output: `ran ${command}` }),
  permission: 'bash',
})

const writeTool = make({
  name: 'write_file',
  description: 'write a file',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  outputSchema: z.string(),
  execute: async ({ path }) => ({ success: true, output: `wrote ${path}` }),
  permission: 'write',
})

describe('permission deny reason injection', () => {
  test('checkHardDeny returns pattern reason', () => {
    expect(checkHardDeny('sudo rm -rf /')).toContain('rm -rf /')
    expect(checkHardDeny('ls')).toBeNull()
  })

  test('evaluateToolCalls produces denyReason for deny rules', () => {
    const registry = new ToolRegistry()
    registry.register(bashTool)
    const permissions = new PermissionSet([
      { action: 'bash', resource: '*', effect: 'deny' },
    ])
    const [ev] = evaluateToolCalls(
      [{ id: 't1', function: { name: 'bash', arguments: JSON.stringify({ command: 'rm -rf x' }) } }],
      registry,
      permissions,
    )
    expect(ev.denyReason).toBeTruthy()
    expect(ev.needsApproval).toBe(false)
  })

  test('evaluateToolCalls asks for approval on ask rules without denyReason', () => {
    const registry = new ToolRegistry()
    registry.register(writeTool)
    const permissions = new PermissionSet([
      { action: 'write', resource: '*', effect: 'ask' },
    ])
    const [ev] = evaluateToolCalls(
      [{ id: 't2', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) } }],
      registry,
      permissions,
    )
    expect(ev.needsApproval).toBe(true)
    expect(ev.denyReason).toBeUndefined()
  })

  test('hard-deny bash returns error containing pattern reason', async () => {
    resetMock()
    const registry = new ToolRegistry()
    registry.register(bashTool)
    const agent = new Agent(registry)

    const config = {
      sessionID: 'test-harddeny-' + Date.now(),
      workspace: '/tmp',
      model: 'gpt-4',
      apiKey: 'test-key',
      apiUrl: 'http://localhost',
    }

    mockState.toolCall = { name: 'bash', arguments: JSON.stringify({ command: 'sudo rm -rf /' }) }
    const events: AgentEvent[] = []
    for await (const event of agent.run('run sudo rm -rf /', [], config)) {
      events.push(event)
    }
    resetMock()

    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult!.result.success).toBe(false)
    expect(toolResult!.result.error).toContain('Permission denied')
    expect(toolResult!.result.error).toContain('rm -rf /')
  })

  test('deny rule rejects tool with reason without asking', async () => {
    resetMock()
    const registry = new ToolRegistry()
    registry.register(writeTool)
    const agent = new Agent(registry)

    const config = {
      sessionID: 'test-denyrulerun-' + Date.now(),
      workspace: '/tmp',
      model: 'gpt-4',
      apiKey: 'test-key',
      apiUrl: 'http://localhost',
      permissions: new PermissionSet([
        { action: 'write', resource: '*', effect: 'deny' },
      ]),
    }

    mockState.toolCall = { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) }
    const events: AgentEvent[] = []
    for await (const event of agent.run('write a file', [], config)) {
      events.push(event)
    }
    resetMock()

    expect(events.some((e) => e.type === 'permission_request')).toBe(false)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult!.result.success).toBe(false)
    expect(toolResult!.result.error).toContain('Permission denied')
    expect(toolResult!.result.error).toContain('denies')
  })

  test('user deny returns error mentioning user denial', async () => {
    resetMock()
    const registry = new ToolRegistry()
    registry.register(writeTool)
    const agent = new Agent(registry)

    const config = {
      sessionID: 'test-userdeny-' + Date.now(),
      workspace: '/tmp',
      model: 'gpt-4',
      apiKey: 'test-key',
      apiUrl: 'http://localhost',
      permissions: new PermissionSet([
        { action: 'write', resource: '*', effect: 'ask' },
      ]),
    }

    mockState.toolCall = { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) }
    const events: AgentEvent[] = []
    for await (const event of agent.run('write a file', [], config)) {
      events.push(event)
      if (event.type === 'permission_request') {
        agent.replyPermission(event.id, 'deny')
      }
    }
    resetMock()

    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult!.result.success).toBe(false)
    expect(toolResult!.result.error).toContain('Permission denied')
    expect(toolResult!.result.error).toContain('user denied')
  })
})
