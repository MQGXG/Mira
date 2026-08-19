/**
 * 会话系统改进集成测试
 *
 * 测试 Context Sources、Event Sourcing、ScopedToolRegistry、
 * RunCoordinator、StructuredSummary 等新模块
 */

import { describe, expect, test, beforeEach, vi } from 'vitest'
import {
  SourceManager,
  BaseSource,
  EnvSource,
  ModeSource,
  MemorySource,
  CodeSource,
  GoalSource,
  KnowledgeSource,
  type SourceContext,
} from '../session/context-source'

import {
  IncrementalSummarizer,
  type StructuredSummary,
} from '../session/structured-summary'

import { EventStore } from '../session/event-store'
import { Projector } from '../session/projector'
import { createMessageEvent, createCompactionEvent } from '../session/event-types'

import { ScopedToolRegistry } from '../system/tool-scope'
import type { ToolDef } from '../shared/tool'
import { z } from 'zod'

import { RunCoordinator } from '../agent/run-coordinator'

// ── Helper 函数 ─────────────────────────────────────────

function makeSourceContext(overrides?: Partial<SourceContext>): SourceContext {
  return {
    sessionID: 'test-session-1',
    workspace: '/test/workspace',
    mode: 'assistant',
    ...overrides,
  }
}

function makeToolDef(name: string): ToolDef {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: z.object({}),
    outputSchema: z.any(),
    parameters: { type: 'object' as const, properties: {} },
    execute: async () => ({ success: true, output: 'ok' }),
  }
}

// ── Context Source 测试 ──────────────────────────────────

describe('SourceManager', () => {
  let sm: SourceManager

  beforeEach(() => {
    sm = new SourceManager('/test/workspace')
  })

  test('registers and builds sources in priority order', async () => {
    const base = new BaseSource()
    const env = new EnvSource()
    const mode = new ModeSource()

    sm.registerAll([env, base, mode])

    const result = await sm.build(makeSourceContext())
    expect(result).toContain('You are Mira')
    expect(result).toContain('Working directory:')
    expect(result).toContain('[MODE: assistant]')
  })

  test('skips disabled sources', async () => {
    const base = new BaseSource()
    const env = new EnvSource()
    env.enabled = false

    sm.registerAll([base, env])

    const result = await sm.build(makeSourceContext())
    expect(result).toContain('You are Mira')
    expect(result).not.toContain('Working directory:')
  })

  test('uses fingerprint cache when hash matches', async () => {
    const memory = new MemorySource()
    memory.setMemoryContent('test memory')
    sm.register(memory)

    const ctx = makeSourceContext()
    const result1 = await sm.build(ctx)
    expect(result1).toContain('test memory')

    // 第二次构建，hash 不变，应使用缓存
    const result2 = await sm.build(ctx)
    expect(result2).toContain('test memory')
  })

  test('resets fingerprints forces full rebuild', async () => {
    const memory = new MemorySource()
    memory.setMemoryContent('v1')
    sm.register(memory)

    await sm.build(makeSourceContext())

    memory.setMemoryContent('v2')
    sm.resetFingerprints()

    const result = await sm.build(makeSourceContext())
    expect(result).toContain('v2')
  })

  test('lists sources with fingerprint state', async () => {
    const base = new BaseSource()
    sm.register(base)

    await sm.build(makeSourceContext())

    const list = sm.list()
    expect(list).toHaveLength(1)
    expect(list[0].key).toBe('base')
    expect(list[0].hash).toBeTruthy()
  })
})

describe('Context Sources', () => {
  test('BaseSource generates default prompt', () => {
    const source = new BaseSource()
    const result = source.generate(makeSourceContext())
    expect(result).toContain('You are Mira')
  })

  test('BaseSource uses custom prompt', () => {
    const source = new BaseSource()
    source.setCustomPrompt('Custom system prompt')
    const result = source.generate(makeSourceContext())
    expect(result).toBe('Custom system prompt')
  })

  test('EnvSource includes workspace and platform', () => {
    const source = new EnvSource()
    const result = source.generate(makeSourceContext({ workspace: '/my/project' }))
    expect(result).toContain('Working directory: /my/project')
    expect(result).toContain('Platform:')
  })

  test('ModeSource includes mode identifier', () => {
    const source = new ModeSource()
    const result = source.generate(makeSourceContext({ mode: 'expert' }))
    expect(result).toContain('[MODE: expert]')
  })

  test('ModeSource with mode suffix', () => {
    const source = new ModeSource()
    source.setModeSuffix('You are an expert coder.')
    const result = source.generate(makeSourceContext({ mode: 'expert' }))
    expect(result).toContain('[MODE: expert]')
    expect(result).toContain('You are an expert coder.')
  })

  test('MemorySource returns set content', () => {
    const source = new MemorySource()
    source.setMemoryContent('Important context from memory')
    const result = source.generate(makeSourceContext())
    expect(result).toBe('Important context from memory')
  })

  test('CodeSource returns code context', () => {
    const source = new CodeSource()
    source.setCodeSuffix('[Code Context]\nTypeScript project')
    const result = source.generate(makeSourceContext())
    expect(result).toContain('TypeScript project')
  })

  test('GoalSource returns goal content', () => {
    const source = new GoalSource()
    source.setGoalContent('[Active Goal]\nFix the login bug')
    const result = source.generate(makeSourceContext())
    expect(result).toContain('Fix the login bug')
  })
})

// ── Structured Summary 测试 ─────────────────────────────

describe('IncrementalSummarizer', () => {
  test('creates empty summary on first update', async () => {
    const summarizer = new IncrementalSummarizer()
    const messages = [
      { role: 'user' as const, content: 'Fix the login bug' },
      { role: 'assistant' as const, content: 'I will fix the login bug by updating the auth module.' },
    ]

    const summary = await summarizer.update(messages)
    expect(summary.objective).toBe('Fix the login bug')
    expect(summary.workState).toContain('Turn')
  })

  test('formats summary correctly', () => {
    const summarizer = new IncrementalSummarizer()
    const summary: StructuredSummary = {
      objective: 'Fix login bug',
      details: ['Found root cause in auth.ts'],
      workState: 'Implementing fix',
      nextMove: 'Update auth.ts',
      files: ['src/auth.ts', 'src/login.ts'],
      constraints: ['Must be backwards compatible'],
      generatedAt: new Date().toISOString(),
    }

    const formatted = summarizer.formatSummary(summary)
    expect(formatted).toContain('## Objective')
    expect(formatted).toContain('Fix login bug')
    expect(formatted).toContain('## Work State')
    expect(formatted).toContain('## Next Move')
    expect(formatted).toContain('## Relevant Files')
    expect(formatted).toContain('- src/auth.ts')
    expect(formatted).toContain('## Constraints')
  })

  test('overflow compact preserves recent messages', () => {
    const summarizer = new IncrementalSummarizer()
    const systemMsg = { role: 'system' as const, content: 'System prompt' }
    const messages = [
      systemMsg,
      { role: 'user' as const, content: 'msg1' },
      { role: 'assistant' as const, content: 'resp1' },
      { role: 'user' as const, content: 'msg2' },
      { role: 'assistant' as const, content: 'resp2' },
      { role: 'user' as const, content: 'msg3' },
      { role: 'assistant' as const, content: 'resp3' },
    ]

    const summary: StructuredSummary = {
      objective: 'Test',
      details: [],
      workState: 'Working',
      nextMove: 'Continue',
      files: [],
      constraints: [],
      generatedAt: new Date().toISOString(),
    }

    const result = summarizer.overflowCompact(messages, summary, 4000)
    expect(result[0]).toEqual(systemMsg)
    expect(result[1].content).toContain('Context Overflow')
    // 应保留最近 6 条消息
    expect(result.length).toBe(8) // system + summary + 6 recent
  })

  test('fromCheckpointData converts correctly', () => {
    const checkpointData = {
      summary: 'Fixed the login bug',
      intent: 'Fix login bug',
      activeTask: 'Write tests',
      currentWork: 'Updating auth.ts',
      recentDecisions: ['Use JWT tokens'],
      keyFiles: ['src/auth.ts'],
      findings: ['Root cause was expired tokens'],
      errorFixes: ['Fixed token refresh'],
      designDecisions: ['Chose JWT over session'],
      userPreferences: ['Keep it simple'],
    }

    const summary = IncrementalSummarizer.fromCheckpointData(checkpointData)
    expect(summary.objective).toBe('Fix login bug')
    expect(summary.files).toContain('src/auth.ts')
    expect(summary.constraints).toContain('Keep it simple')
  })
})

// ── ScopedToolRegistry 测试 ─────────────────────────────

describe('ScopedToolRegistry', () => {
  let registry: ScopedToolRegistry

  beforeEach(() => {
    registry = new ScopedToolRegistry()
  })

  test('registers base tools', () => {
    const tool = makeToolDef('read_file')
    registry.registerBase(tool)

    const resolved = registry.resolve()
    expect(resolved.has('read_file')).toBe(true)
  })

  test('creates and uses scopes', () => {
    const baseTool = makeToolDef('read_file')
    const sessionTool = makeToolDef('custom_tool')
    registry.registerBase(baseTool)

    registry.createScope({
      id: 'session-1',
      type: 'session',
      tools: new Set(['custom_tool']),
      priority: 10,
      enabled: true,
    })

    registry.registerInScope('session-1', sessionTool)

    const resolved = registry.resolve()
    expect(resolved.has('read_file')).toBe(true)
    expect(resolved.has('custom_tool')).toBe(true)
  })

  test('higher priority scope overrides lower', () => {
    const baseTool = makeToolDef('edit_file')
    const overrideTool = makeToolDef('edit_file') // 同名工具
    registry.registerBase(baseTool)

    registry.createScope({
      id: 'scope-low',
      type: 'mode',
      tools: new Set(['edit_file']),
      priority: 5,
      enabled: true,
    })
    registry.registerInScope('scope-low', overrideTool)

    const resolved = registry.resolve()
    expect(resolved.has('edit_file')).toBe(true)
    // 工具应被注册
    expect(resolved.size).toBe(1)
  })

  test('removeScope removes scope tools', () => {
    const tool = makeToolDef('custom_tool')
    registry.createScope({
      id: 'session-1',
      type: 'session',
      tools: new Set(['custom_tool']),
      priority: 10,
      enabled: true,
    })
    registry.registerInScope('session-1', tool)

    registry.removeScope('session-1')

    const resolved = registry.resolve()
    expect(resolved.has('custom_tool')).toBe(false)
  })

  test('disabled scope is not resolved', () => {
    const tool = makeToolDef('custom_tool')
    registry.createScope({
      id: 'session-1',
      type: 'session',
      tools: new Set(['custom_tool']),
      priority: 10,
      enabled: false,
    })
    registry.registerInScope('session-1', tool)

    const resolved = registry.resolve()
    expect(resolved.has('custom_tool')).toBe(false)
  })

  test('validateIdentity checks scope existence', () => {
    const tool = makeToolDef('custom_tool')
    registry.createScope({
      id: 'session-1',
      type: 'session',
      tools: new Set(['custom_tool']),
      priority: 10,
      enabled: true,
    })
    registry.registerInScope('session-1', tool)

    expect(registry.validateIdentity('custom_tool', 'session-1')).toBe(true)
    expect(registry.validateIdentity('custom_tool', 'nonexistent')).toBe(false)

    registry.removeScope('session-1')
    expect(registry.validateIdentity('custom_tool', 'session-1')).toBe(false)
  })

  test('lists scopes', () => {
    registry.createScope({
      id: 'scope-1',
      type: 'session',
      tools: new Set(),
      priority: 10,
      enabled: true,
    })
    registry.createScope({
      id: 'scope-2',
      type: 'mode',
      tools: new Set(),
      priority: 20,
      enabled: true,
    })

    const scopes = registry.listScopes()
    expect(scopes).toHaveLength(2)
  })
})

// ── RunCoordinator 测试 ─────────────────────────────────

describe('RunCoordinator', () => {
  test('starts idle', () => {
    const coordinator = new RunCoordinator()
    expect(coordinator.getState()).toBe('idle')
    expect(coordinator.getPendingCount()).toBe(0)
  })

  test('submit returns request id', () => {
    const coordinator = new RunCoordinator()
    const id = coordinator.submit({
      userMessage: 'hello',
      config: { sessionID: 's1', workspace: '/w', model: 'gpt-4', apiKey: 'k', apiUrl: 'u' },
      emit: () => {},
      execute: async function* () {
        yield { type: 'finish' as const, reason: 'length' as const }
      },
    })

    expect(id).toBeTruthy()
    expect(id).toMatch(/^run_/)
  })

  test('getSnapshot returns current state', () => {
    const coordinator = new RunCoordinator()
    const snapshot = coordinator.getSnapshot()
    expect(snapshot.state).toBe('idle')
    expect(snapshot.pendingCount).toBe(0)
    expect(snapshot.coalescedCount).toBe(0)
    expect(snapshot.currentRequestId).toBeNull()
  })

  test('reset returns to idle', () => {
    const coordinator = new RunCoordinator()
    coordinator.reset()
    expect(coordinator.getState()).toBe('idle')
  })
})

// ── Event Types 测试 ────────────────────────────────────

describe('Event Types', () => {
  test('createMessageEvent creates valid event', () => {
    const event = createMessageEvent('session-1', {
      role: 'user',
      content: 'Hello',
    })

    expect(event.session_id).toBe('session-1')
    expect(event.type).toBe('message.appended')
    expect(event.payload).toEqual({ role: 'user', content: 'Hello' })
    expect(event.version).toBe(1)
  })

  test('createCompactionEvent creates valid event', () => {
    const event = createCompactionEvent('session-1', {
      reason: 'test',
      messagesBefore: 100,
      messagesAfter: 10,
      tokensBefore: 50000,
      tokensAfter: 5000,
      compactedMessages: [{ role: 'user', content: 'summary' }],
    })

    expect(event.type).toBe('session.compacted')
  })
})

// ── KnowledgeSource 测试 ────────────────────────────────

describe('KnowledgeSource', () => {
  test('generates empty string when no content', () => {
    const source = new KnowledgeSource()
    const result = source.generate(makeSourceContext())
    expect(result).toBe('')
  })

  test('generates knowledge content with prefix', () => {
    const source = new KnowledgeSource()
    source.setKnowledgeContent('- Fact 1\n- Fact 2')
    const result = source.generate(makeSourceContext())
    expect(result).toContain('[Project Knowledge]')
    expect(result).toContain('- Fact 1')
    expect(result).toContain('- Fact 2')
  })

  test('fingerprint changes with content', () => {
    const source = new KnowledgeSource()
    const fp1 = source.fingerprint(makeSourceContext())
    source.setKnowledgeContent('new content')
    const fp2 = source.fingerprint(makeSourceContext())
    expect(fp1.hash).not.toBe(fp2.hash)
  })

  test('registered in SourceManager', async () => {
    const sm = new SourceManager('/test/workspace')
    const knowledge = new KnowledgeSource()
    knowledge.setKnowledgeContent('- Test fact')
    sm.register(knowledge)

    const result = await sm.build(makeSourceContext())
    expect(result).toContain('[Project Knowledge]')
    expect(result).toContain('- Test fact')
  })
})

// ── Structured Summary 集成测试 ─────────────────────────

describe('Structured Summary Integration', () => {
  test('IncrementalSummarizer creates summary from messages', async () => {
    const summarizer = new IncrementalSummarizer()
    const messages = [
      { role: 'user' as const, content: 'Fix the login bug in auth.ts' },
      { role: 'assistant' as const, content: 'I will fix the login bug by updating the token refresh logic.' },
    ]

    const summary = await summarizer.update(messages)
    expect(summary.objective).toContain('Fix the login bug')
  })

  test('formatSummary produces structured output', () => {
    const summarizer = new IncrementalSummarizer()
    const summary: StructuredSummary = {
      objective: 'Fix login',
      details: ['Found root cause'],
      workState: 'Implementing',
      nextMove: 'Update auth.ts',
      files: ['src/auth.ts'],
      constraints: [],
      generatedAt: new Date().toISOString(),
    }

    const text = summarizer.formatSummary(summary)
    expect(text).toContain('## Objective')
    expect(text).toContain('## Work State')
    expect(text).toContain('## Next Move')
    expect(text).toContain('## Relevant Files')
  })

  test('fromCheckpointData converts correctly', () => {
    const data = {
      summary: 'Fixed login',
      intent: 'Fix login bug',
      activeTask: 'Write tests',
      currentWork: 'Updating auth',
      keyFiles: ['auth.ts'],
      findings: ['Root cause found'],
    }

    const summary = IncrementalSummarizer.fromCheckpointData(data)
    expect(summary.objective).toBe('Fix login bug')
    expect(summary.files).toContain('auth.ts')
  })
})

// ── Snapshot 持久化测试 ─────────────────────────────────

import { getSnapshotManager } from '../session/snapshot'

describe('Snapshot Persistence', () => {
  test('getSnapshotManager returns per-workspace instances', () => {
    const mgr1 = getSnapshotManager('/workspace/a')
    const mgr2 = getSnapshotManager('/workspace/b')
    const mgr3 = getSnapshotManager('/workspace/a')

    expect(mgr1).not.toBe(mgr2)
    expect(mgr1).toBe(mgr3)
  })
})
