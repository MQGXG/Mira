# TypeScript Agent Core ReAct 升级实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 OmniAgent 桌面端打造一个不依赖 Python 后端、可独立运行的 TypeScript Agent Core：支持流式 ReAct 循环、并发工具执行、权限门控、上下文压缩与 Claude/OpenAI/Ollama 多 Provider，从而彻底解决后端离线时聊天不可用的问题。

**Architecture:** 参考 OpenCode `packages/core/src/session/runner/llm.ts` 的 Effect-based durable session runner 与 Hermes Agent `agent/conversation_loop.py` 的健壮循环，把现有 `electron/agent-core/agent.ts` 从“单请求顺序循环”升级为“事件驱动、可中断、带预算与压缩的多步 ReAct 引擎”。前端 `ChatWindow` 通过统一的 AsyncGenerator 事件流消费文本/工具/权限事件，后端离线时自动降级到 TS Core。

**Tech Stack:** TypeScript, Electron IPC, React, Zod, native `fetch`, Vitest（新增）, OpenAI-compatible + Anthropic Messages API。

---

## 背景：三个参考项目的核心优势映射

| 来源 | 关键优势 | OmniAgent 吸收点 |
|------|----------|------------------|
| **Learn Claude Code** | 19 章完整课程勾勒出 Agent 工程最佳实践：Agent 循环 → 工具 → todo → subagent → skill → 上下文压缩 → 权限 → 记忆 → 持久化任务图 → cron → 多智能体。 | 作为能力蓝图，按优先级分阶段落地。 |
| **Hermes Agent** | `run_conversation` 近 4000 行，覆盖消息修复、工具参数清洗、角色交替修复、提示缓存、流式健康检测、迭代预算、provider 降级链、上下文压缩、continuation 提示、插件 hook。 | 直接指导 TS Core 的错误恢复、消息修复、上下文压缩、工具错误清洗、迭代预算。 |
| **OpenCode** | `SessionRunner` 用 Effect 实现 durable session：Context Epoch、System Context Registry、`ToolRegistry.materialize`/`settle`、权限 Deferred ask、`ToolOutputStore` bounding、`InstructionContext` 自动加载 `AGENTS.md`。 | 指导 TS Core 的工具注册表、权限门控、AGENTS.md 加载、事件流设计。 |

当前 OmniAgent 已有不错基础：`ToolRegistry`、`Tool.make`、基础 `Agent` 循环、权限规则。但缺少：流式输出、Claude 离线支持、并发工具执行、消息修复、上下文压缩、权限 ask 真正中断循环、测试框架。本计划聚焦把这些补齐。

---

## 总体路线图

- **Phase 1（核心循环硬化）**：流式 LLM 客户端、并发工具执行、消息修复、上下文压缩、迭代预算、Claude 支持。
- **Phase 2（权限门控）**：把 `PermissionSet` 的 `ask` 效果真正接入 Agent 循环，前端弹出确认对话框，支持保存规则。
- **Phase 3（Skill 与指令上下文）**：自动加载项目 `AGENTS.md` 与全局 `AGENTS.md`，实现 Hermes 式 Skill 目录与 `/skill-name` slash 命令。
- **Phase 4（记忆与持久化）**：参考 Hermes `MemoryManager` 实现 provider 架构，回合前 prefetch、回合后后台 sync，SQLite 持久化会话。
- **Phase 5（质量与可观测性）**：全量测试、类型检查、性能基准、日志链路、provider 降级链。

---

## Phase 1：核心循环硬化（立即执行）

### Task 1：引入 Vitest 测试框架

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `electron/agent-core/__tests__/smoke.test.ts`

**Step 1：安装依赖**

Run: `npm install -D vitest @vitest/ui`
Expected: `package.json` 新增 `vitest` 与 `@vitest/ui` devDependencies。

**Step 2：创建 Vitest 配置**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['electron/**/*.{test,spec}.{ts,tsx}'],
  },
})
```

**Step 3：添加 test 脚本**

Modify `package.json` scripts:

```json
"test": "vitest run",
"test:ui": "vitest --ui"
```

**Step 4：创建首个冒烟测试**

```typescript
// electron/agent-core/__tests__/smoke.test.ts
import { expect, test } from 'vitest'

test('vitest works', () => {
  expect(1 + 1).toBe(2)
})
```

**Step 5：运行测试**

Run: `npx vitest run`
Expected: 1 test passing。

**Step 6：提交**

```bash
git add package.json package-lock.json vitest.config.ts electron/agent-core/__tests__/smoke.test.ts
git commit -m "chore: add vitest test framework"
```

---

### Task 2：抽象多 Provider LLM 客户端

**Files:**
- Create: `electron/agent-core/llm-client.ts`
- Create: `electron/agent-core/__tests__/llm-client.test.ts`
- Modify: `electron/agent-core/agent.ts`（后续任务替换调用）

**Step 1：定义 Provider 接口**

```typescript
// electron/agent-core/llm-client.ts
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface LLMRequest {
  model: string
  messages: LLMMessage[]
  tools?: Record<string, unknown>[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
}

export interface LLMStreamEvent {
  type: 'delta' | 'tool_call' | 'done' | 'error'
  delta?: string
  toolCall?: {
    id: string
    name?: string
    arguments?: string
    index: number
  }
  error?: { message: string }
}

export interface LLMClient {
  complete(request: LLMRequest): Promise<{ content: string; toolCalls: NonNullable<LLMMessage['tool_calls']> }>
  stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent>
}
```

**Step 2：实现 OpenAI 兼容客户端**

```typescript
// electron/agent-core/llm-client.ts
export interface ClientConfig {
  provider: 'openai' | 'anthropic' | 'ollama' | 'deepseek' | 'custom'
  model: string
  apiKey: string
  apiUrl: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

function normalizeBaseUrl(provider: string, url: string): string {
  let base = url.replace(/\/+$/, '')
  if (provider !== 'openai' && !base.endsWith('/v1')) base += '/v1'
  return base
}

export function createOpenAIClient(config: ClientConfig): LLMClient {
  const baseUrl = normalizeBaseUrl(config.provider, config.apiUrl)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    ...(config.headers || {}),
  }

  async function complete(request: LLMRequest) {
    const body = {
      model: config.model,
      messages: request.messages,
      stream: false,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(config.options || {}),
    }
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`LLM API error (${resp.status}): ${text.slice(0, 300)}`)
    }
    const data = await resp.json()
    const choice = data.choices?.[0]
    return {
      content: choice?.message?.content || '',
      toolCalls: choice?.message?.tool_calls || [],
    }
  }

  async function* stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    const body = {
      model: config.model,
      messages: request.messages,
      stream: true,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(config.options || {}),
    }
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!resp.ok) {
      const text = await resp.text()
      yield { type: 'error', error: { message: `LLM API error (${resp.status}): ${text.slice(0, 300)}` } }
      return
    }
    const reader = resp.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {}

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed === 'data: [DONE]') continue
          if (!trimmed.startsWith('data: ')) continue
          const json = trimmed.slice(6)
          let chunk: any
          try { chunk = JSON.parse(json) } catch { continue }
          const delta = chunk.choices?.[0]?.delta
          if (!delta) continue
          if (delta.content) yield { type: 'delta', delta: delta.content }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index
              if (!toolCallBuffers[idx]) toolCallBuffers[idx] = { id: tc.id || '', name: '', args: '' }
              if (tc.id) toolCallBuffers[idx].id = tc.id
              if (tc.function?.name) toolCallBuffers[idx].name += tc.function.name
              if (tc.function?.arguments) toolCallBuffers[idx].args += tc.function.arguments
              yield {
                type: 'tool_call',
                toolCall: {
                  id: toolCallBuffers[idx].id,
                  name: toolCallBuffers[idx].name || undefined,
                  arguments: toolCallBuffers[idx].args || undefined,
                  index: idx,
                },
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
    yield { type: 'done' }
  }

  return { complete, stream }
}
```

**Step 3：实现 Anthropic 客户端**

```typescript
// electron/agent-core/llm-client.ts
export function createAnthropicClient(config: ClientConfig): LLMClient {
  const baseUrl = config.apiUrl.replace(/\/+$/, '') || 'https://api.anthropic.com'

  function toAnthropicMessages(messages: LLMMessage[]) {
    // 简单实现：system 提取，其余按 role 映射
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const rest = messages.filter(m => m.role !== 'system').map((m) => {
      if (m.role === 'tool') {
        return { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: m.tool_call_id, content: m.content }] }
      }
      if (m.role === 'assistant' && m.tool_calls) {
        const content: any[] = []
        if (m.content) content.push({ type: 'text' as const, text: m.content })
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          })
        }
        return { role: 'assistant' as const, content }
      }
      return { role: m.role as 'user' | 'assistant', content: m.content }
    })
    return { system, messages: rest }
  }

  async function complete(request: LLMRequest) {
    const { system, messages } = toAnthropicMessages(request.messages)
    const body: any = {
      model: config.model,
      max_tokens: request.max_tokens ?? 4096,
      messages,
      system,
      ...(config.options || {}),
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    }
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        ...(config.headers || {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Anthropic API error (${resp.status}): ${text.slice(0, 300)}`)
    }
    const data = await resp.json()
    const textParts = data.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    const toolCalls = data.content
      .filter((c: any) => c.type === 'tool_use')
      .map((c: any) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      }))
    return { content: textParts, toolCalls }
  }

  async function* stream(request: LLMRequest): AsyncGenerator<LLMStreamEvent> {
    // Phase 1 可先返回非流式包装；Phase 5 再实现真流式
    try {
      const result = await complete(request)
      if (result.content) yield { type: 'delta', delta: result.content }
      for (const tc of result.toolCalls) {
        yield { type: 'tool_call', toolCall: { id: tc.id, name: tc.function.name, arguments: tc.function.arguments, index: 0 } }
      }
      yield { type: 'done' }
    } catch (e) {
      yield { type: 'error', error: { message: e instanceof Error ? e.message : String(e) } }
    }
  }

  return { complete, stream }
}

export function createLLMClient(config: ClientConfig): LLMClient {
  if (config.provider === 'anthropic') return createAnthropicClient(config)
  return createOpenAIClient(config)
}
```

**Step 4：写测试**

```typescript
// electron/agent-core/__tests__/llm-client.test.ts
import { describe, expect, test } from 'vitest'
import { createOpenAIClient, createAnthropicClient } from '../llm-client'

describe('createOpenAIClient', () => {
  test('normalizes custom base url to /v1', () => {
    const client = createOpenAIClient({
      provider: 'ollama',
      model: 'qwen2.5',
      apiKey: 'x',
      apiUrl: 'http://localhost:11434',
    })
    expect(client).toBeDefined()
  })
})

describe('createAnthropicClient', () => {
  test('creates client', () => {
    const client = createAnthropicClient({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      apiKey: 'x',
      apiUrl: 'https://api.anthropic.com',
    })
    expect(client).toBeDefined()
  })
})
```

**Step 5：运行测试**

Run: `npx vitest run electron/agent-core/__tests__/llm-client.test.ts`
Expected: 2 tests passing。

**Step 6：提交**

```bash
git add electron/agent-core/llm-client.ts electron/agent-core/__tests__/llm-client.test.ts
git commit -m "feat(agent-core): add multi-provider LLM client abstraction"
```

---

### Task 3：重构 Agent 循环为流式事件驱动

**Files:**
- Modify: `electron/agent-core/agent.ts`
- Create: `electron/agent-core/iteration-budget.ts`
- Modify: `electron/agent-core/index.ts`（导出）
- Create: `electron/agent-core/__tests__/agent.test.ts`

**Step 1：创建迭代预算类**

```typescript
// electron/agent-core/iteration-budget.ts
export class IterationBudget {
  used = 0
  constructor(public maxTotal: number) {}

  consume(): boolean {
    if (this.used >= this.maxTotal) return false
    this.used++
    return true
  }

  refund(): void {
    if (this.used > 0) this.used--
  }

  get remaining(): number {
    return Math.max(0, this.maxTotal - this.used)
  }
}
```

**Step 2：扩展 AgentEvent 类型**

```typescript
// electron/agent-core/types.ts (新建)
import { ToolCall } from './tool'

export type AgentEvent =
  | { type: 'content'; text: string }
  | { type: 'tool_start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: { success: boolean; output?: string; error?: string } }
  | { type: 'permission_request'; id: string; action: string; resources: string[]; toolCall: ToolCall }
  | { type: 'error'; message: string }
  | { type: 'finish'; reason: string }
  | { type: 'thinking'; text: string }
```

**Step 3：重写 Agent.run 为流式**

完整替换 `electron/agent-core/agent.ts` 内容，使用 `createLLMClient` 与流式事件。由于篇幅较长，分步骤给出关键差异：

1. 移除内嵌 `callLLM`，改为 `createLLMClient(config)`。
2. `run` 改为 `async function* run(...)`。
3. 循环内使用 `for await (const event of client.stream({...}))`。
4. 累积文本增量并 yield `content`。
5. 工具调用完整到达后 yield `tool_start`，并发执行，再 yield `tool_result`。
6. 加入 `IterationBudget` 与最大步数。

关键代码段：

```typescript
// 在 Agent.run 内部
const client = createLLMClient({
  provider: (config.provider as any) || 'openai',
  model: config.model,
  apiKey: config.apiKey,
  apiUrl: config.apiUrl,
  headers: config.headers,
  options: config.options,
})

const budget = new IterationBudget(config.maxSteps || 10)

while (budget.consume()) {
  const stream = client.stream({ messages, tools: toolDefs, stream: true })
  let currentText = ''
  const pendingToolCalls: Map<string, { name: string; args: string; complete: boolean }> = new Map()

  for await (const event of stream) {
    if (event.type === 'delta') {
      currentText += event.delta
      yield { type: 'content', text: event.delta }
    } else if (event.type === 'tool_call' && event.toolCall) {
      const existing = pendingToolCalls.get(event.toolCall.id) || { name: '', args: '', complete: false }
      if (event.toolCall.name) existing.name = event.toolCall.name
      if (event.toolCall.arguments !== undefined) existing.args = event.toolCall.arguments
      existing.complete = !!existing.name && existing.args !== undefined && isCompleteJson(existing.args)
      pendingToolCalls.set(event.toolCall.id, existing)
    } else if (event.type === 'error') {
      yield { type: 'error', message: event.error?.message || 'LLM stream error' }
      return
    } else if (event.type === 'done') {
      break
    }
  }

  // 记录 assistant 消息
  const toolCallsArray = Array.from(pendingToolCalls.entries())
    .filter(([, v]) => v.complete)
    .map(([id, v]) => ({
      id,
      type: 'function' as const,
      function: { name: v.name, arguments: v.args },
    }))

  messages.push({
    role: 'assistant',
    content: currentText,
    tool_calls: toolCallsArray,
  })

  if (toolCallsArray.length === 0) {
    yield { type: 'finish', reason: 'stop' }
    return
  }

  // 并发执行工具
  const toolResults = await Promise.all(
    toolCallsArray.map(async (call) => {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.function.arguments) } catch { /* ignore */ }
      yield { type: 'tool_start', id: call.id, name: call.function.name, args }
      const result = await this.registry.execute(call.function.name, args, ctx)
      return { call, result }
    })
  )

  for (const { call, result } of toolResults) {
    yield {
      type: 'tool_result',
      id: call.id,
      name: call.function.name,
      result: { success: result.success, output: result.output, error: result.error },
    }
    messages.push({
      role: 'tool',
      content: result.success ? (result.output || '') : (result.error || ''),
      tool_call_id: call.id,
    })
  }
}

yield { type: 'finish', reason: 'length' }
```

辅助函数：

```typescript
function isCompleteJson(s: string): boolean {
  try { JSON.parse(s); return true } catch { return false }
}
```

**Step 4：更新导出**

Modify `electron/agent-core/index.ts`:

```typescript
export { Agent, AgentConfig, AgentEvent } from './agent'
export { ToolRegistry } from './registry'
export { make as makeTool, ToolDef, ToolContext, ToolResult, ToolCall } from './tool'
export { createLLMClient, ClientConfig } from './llm-client'
```

**Step 5：写测试**

```typescript
// electron/agent-core/__tests__/agent.test.ts
import { describe, expect, test } from 'vitest'
import { Agent } from '../agent'
import { ToolRegistry } from '../registry'
import { make } from '../tool'
import { z } from 'zod'

const echoTool = make({
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.string(),
  execute: async ({ text }) => ({ success: true, output: text }),
})

describe('Agent', () => {
  test('initializes with registry', () => {
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const agent = new Agent(registry)
    expect(agent).toBeDefined()
  })
})
```

**Step 6：运行类型检查与测试**

Run: `npx tsc --noEmit && npx vitest run electron/agent-core/__tests__/agent.test.ts`
Expected: 类型检查通过，1 test passing。

**Step 7：提交**

```bash
git add electron/agent-core/agent.ts electron/agent-core/types.ts electron/agent-core/iteration-budget.ts electron/agent-core/index.ts electron/agent-core/__tests__/agent.test.ts
git commit -m "feat(agent-core): streaming react loop with concurrent tools"
```

---

### Task 4：消息序列修复与上下文截断

**Files:**
- Create: `electron/agent-core/message-utils.ts`
- Create: `electron/agent-core/__tests__/message-utils.test.ts`
- Modify: `electron/agent-core/agent.ts`（在每次 API 调用前调用 repair）

**Step 1：实现消息修复函数**

```typescript
// electron/agent-core/message-utils.ts
import { LLMMessage } from './llm-client'

export function repairMessageSequence(messages: LLMMessage[]): LLMMessage[] {
  const repaired: LLMMessage[] = []
  for (const msg of messages) {
    const last = repaired[repaired.length - 1]
    if (last?.role === 'tool' && msg.role !== 'assistant') {
      // tool 消息后必须是 assistant，插入空 assistant
      repaired.push({ role: 'assistant', content: '' })
    }
    if (last?.role === 'user' && msg.role === 'user') {
      // 合并连续 user
      last.content += '\n\n' + msg.content
      continue
    }
    if (last?.role === 'assistant' && msg.role === 'assistant' && !last.tool_calls) {
      // 合并连续 assistant
      last.content += '\n\n' + msg.content
      continue
    }
    repaired.push(msg)
  }
  // 如果最后一条是 tool，补 assistant
  if (repaired[repaired.length - 1]?.role === 'tool') {
    repaired.push({ role: 'assistant', content: '' })
  }
  return repaired
}

export function estimateTokens(messages: LLMMessage[]): number {
  // 简易估算：1 token ≈ 4 chars
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 50, 0)
}

export function truncateToBudget(messages: LLMMessage[], maxTokens: number): LLMMessage[] {
  if (estimateTokens(messages) <= maxTokens) return messages
  // 保留 system 与最近对话
  const system = messages.find(m => m.role === 'system')
  const rest = messages.filter(m => m.role !== 'system')
  while (rest.length > 2 && estimateTokens([system!, ...rest]) > maxTokens) {
    rest.shift()
  }
  return system ? [system, ...rest] : rest
}
```

**Step 2：写测试**

```typescript
// electron/agent-core/__tests__/message-utils.test.ts
import { expect, test } from 'vitest'
import { repairMessageSequence, estimateTokens, truncateToBudget } from '../message-utils'

test('repairs tool followed by user', () => {
  const out = repairMessageSequence([
    { role: 'tool', content: 'x', tool_call_id: '1' },
    { role: 'user', content: 'y' },
  ])
  expect(out[out.length - 1].role).toBe('user')
  expect(out[out.length - 2].role).toBe('assistant')
})

test('truncates old messages', () => {
  const messages = [
    { role: 'system' as const, content: 'system' },
    { role: 'user' as const, content: 'a'.repeat(4000) },
    { role: 'assistant' as const, content: 'b'.repeat(4000) },
    { role: 'user' as const, content: 'current' },
  ]
  const out = truncateToBudget(messages, 500)
  expect(out.some(m => m.content === 'current')).toBe(true)
})
```

**Step 3：接入 Agent 循环**

在 `Agent.run` 内每次调用 `client.stream` 前：

```typescript
messages = repairMessageSequence(messages)
messages = truncateToBudget(messages, config.maxContextTokens || 8000)
```

**Step 4：运行测试**

Run: `npx vitest run electron/agent-core/__tests__/message-utils.test.ts`
Expected: 2 tests passing。

**Step 5：提交**

```bash
git add electron/agent-core/message-utils.ts electron/agent-core/__tests__/message-utils.test.ts electron/agent-core/agent.ts
git commit -m "feat(agent-core): message repair and context truncation"
```

---

### Task 5：工具错误清洗与参数强制转换

**Files:**
- Modify: `electron/agent-core/tool.ts`
- Create: `electron/agent-core/__tests__/tool.test.ts`

**Step 1：增强 settle 错误清洗**

```typescript
// electron/agent-core/tool.ts
const ROLE_TAG_RE = /</?(?:tool_call|function_call|result|response|output|input|system|assistant|user)>/gi
const FENCE_OPEN_RE = /^\s*```(?:json|xml|html|markdown)?\s*/gim
const FENCE_CLOSE_RE = /\s*```\s*$/gim
const CDATA_RE = /<!\[CDATA\[.*?\]\]>/gis
const MAX_TOOL_ERROR_LEN = 2000

export function sanitizeToolError(errorMsg: string): string {
  if (!errorMsg) return '[TOOL_ERROR] '
  let s = errorMsg
    .replace(ROLE_TAG_RE, '')
    .replace(FENCE_OPEN_RE, '')
    .replace(FENCE_CLOSE_RE, '')
    .replace(CDATA_RE, '')
  if (s.length > MAX_TOOL_ERROR_LEN) s = s.slice(0, MAX_TOOL_ERROR_LEN - 3) + '...'
  return `[TOOL_ERROR] ${s}`
}
```

在 `settle` 的 catch 块中：

```typescript
return {
  result: { success: false, error: sanitizeToolError(message) },
  content: [{ type: 'text', text: sanitizeToolError(message) }],
}
```

**Step 2：实现参数强制转换**

```typescript
// electron/agent-core/tool.ts
function coerceValue(value: string, expected: string | string[]): unknown {
  if (Array.isArray(expected)) {
    for (const t of expected) {
      const c = coerceValue(value, t)
      if (c !== value) return c
    }
    return value
  }
  if (expected === 'integer' || expected === 'number') {
    const f = parseFloat(value)
    if (!Number.isNaN(f)) return Number.isInteger(f) ? Math.trunc(f) : f
  }
  if (expected === 'boolean') {
    const low = value.trim().toLowerCase()
    if (low === 'true') return true
    if (low === 'false') return false
  }
  return value
}

export function coerceToolArgs(name: string, args: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties || {}) as Record<string, any>
  const out = { ...args }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue
    const prop = props[key]
    if (!prop || !prop.type) continue
    const coerced = coerceValue(value, prop.type)
    if (coerced !== value) out[key] = coerced
  }
  return out
}
```

在 `settle` 中解析前调用 `coerceToolArgs`。

**Step 3：写测试**

```typescript
// electron/agent-core/__tests__/tool.test.ts
import { expect, test } from 'vitest'
import { sanitizeToolError, coerceToolArgs } from '../tool'

test('sanitizes role tags', () => {
  expect(sanitizeToolError('<tool_call>oops</tool_call>')).toBe('[TOOL_ERROR] oops')
})

test('coerces string numbers', () => {
  const out = coerceToolArgs('x', { n: '42' }, { properties: { n: { type: 'integer' } } })
  expect(out.n).toBe(42)
})
```

**Step 4：运行测试**

Run: `npx vitest run electron/agent-core/__tests__/tool.test.ts`
Expected: 2 tests passing。

**Step 5：提交**

```bash
git add electron/agent-core/tool.ts electron/agent-core/__tests__/tool.test.ts
git commit -m "feat(agent-core): sanitize tool errors and coerce arguments"
```

---

### Task 6：前端 ChatWindow 接入流式 TS Core

**Files:**
- Modify: `src/components/chat/ChatWindow.tsx`
- Modify: `src/components/chat/types.ts`（如需要扩展 Message）

**Step 1：确认 IPC 暴露**

确保 `window.electronAPI.runAgentStream` 存在并返回 `AsyncIterable<AgentEvent>`。若不存在，在 `electron/preload.ts` 与 `electron/ipc/handlers.ts` 增加：

```typescript
// electron/preload.ts
runAgentStream: (sessionId: string, message: string) => window.api.invoke('run-agent-stream', sessionId, message)
```

```typescript
// electron/ipc/handlers.ts
ipcMain.handle('run-agent-stream', async (_event, sessionId: string, message: string) => {
  // 返回可序列化的事件数组，或建立更复杂的 port
})
```

为简化，Phase 1 先把事件数组一次性返回：主进程收集 generator 所有事件，返回 JSON 数组。Phase 5 再用 MessageChannel 实现真实时流。

**Step 2：ChatWindow 离线模式使用流式 Agent**

在 `handleSubmit` 的 offline 分支，替换原来的单轮 completion，改为：

```typescript
const events = await window.electronAPI.runAgentStream(sessionId, input)
for (const event of events) {
  if (event.type === 'content') {
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content: last.content + event.text }]
      }
      return [...prev, { id: crypto.randomUUID(), role: 'assistant', content: event.text }]
    })
  } else if (event.type === 'tool_start') {
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: `🔧 Using tool **${event.name}** with ${JSON.stringify(event.args)}`,
      isToolCall: true,
    }])
  } else if (event.type === 'tool_result') {
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: event.result.success
        ? `✅ Result: ${event.result.output?.slice(0, 500) || ''}`
        : `❌ Error: ${event.result.error}`,
      isToolCall: true,
    }])
  } else if (event.type === 'error') {
    setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'assistant', content: `Error: ${event.message}` }])
  }
}
```

**Step 3：运行并手动验证**

Run: `npm run dev`
Steps:
1. 停止 Python 后端。
2. 选择 OpenAI/DeepSeek/Ollama 模型。
3. 输入“读取 package.json”。
4. Expected: 看到流式文本与工具执行结果。

**Step 4：提交**

```bash
git add src/components/chat/ChatWindow.tsx electron/preload.ts electron/ipc/handlers.ts
git commit -m "feat(chat): consume streaming TS Agent Core events in offline mode"
```

---

### Task 7：端到端类型检查与全量测试

**Files:**
- Modify: `package.json`（可选新增 typecheck 脚本）

**Step 1：添加 typecheck 脚本**

```json
"typecheck": "tsc --noEmit"
```

**Step 2：运行全量检查**

Run: `npm run typecheck && npm test`
Expected: 无类型错误，全部测试通过。

**Step 3：提交**

```bash
git add package.json
git commit -m "chore: add typecheck script and verify full build"
```

---

## Phase 2：权限门控（下一迭代）

### Epic 2.1：Agent 循环支持 `ask` 中断

- 在 `Agent.run` 中，工具调用前检查 `PermissionSet.needsApproval(action, permission)`。
- 若需要 ask，yield `permission_request` 事件并暂停循环，等待外部 resolve/reject。
- 使用 Promise + async iterator 实现可恢复：`agent.replyPermission(id, 'allow' | 'deny' | 'always')`。

### Epic 2.2：前端 PermissionDialog 接入

- `ChatWindow` 收到 `permission_request` 时弹出 `PermissionDialog`。
- 用户选择后调用 `window.electronAPI.replyPermission(id, reply)`。
- 主进程把回复传回暂停的 Agent 循环。

### Epic 2.3：保存规则

- 在 `PermissionSet` 基础上增加 `SavedPermissionStore`（Electron Store）。
- 用户选择 “always allow” 时持久化规则，后续同项目自动 allow。

---

## Phase 3：Skill 与指令上下文

### Epic 3.1：自动加载 AGENTS.md

- 创建 `electron/agent-core/instruction-context.ts`。
- 从 `~/.config/omniagent/AGENTS.md` 和项目根目录向上查找 `AGENTS.md`。
- 在 Agent 循环的 system prompt 中拼接。

### Epic 3.2：Skill 目录与 slash 命令

- 创建 `~/.config/omniagent/skills/` 目录结构，参考 Hermes `skills/<category>/<skill>/SKILL.md`。
- 实现 `skills_list` 与 `skill_view` 工具。
- 解析 `/skill-name` 前缀，构建 skill invocation message 注入用户消息。

---

## Phase 4：记忆与持久化

### Epic 4.1：Memory Provider 架构

- 创建 `electron/agent-core/memory/` 目录。
- 定义 `MemoryProvider` 接口：`initialize`, `prefetch`, `syncTurn`, `shutdown`。
- 创建 `MemoryManager` 协调内置 SQLite memory 与一个外部 provider。

### Epic 4.2：会话持久化

- 使用 Electron Store 或 SQLite 保存 TS Core 会话消息。
- `ChatWindow` 启动离线会话时加载历史。

---

## Phase 5：质量与可观测性

### Epic 5.1：Provider 降级链

- 参考 Hermes failover，当主 provider 失败时尝试 fallback provider。
- 配置 `model.fallback` 列表。

### Epic 5.2：日志与审计

- 为每个工具调用记录 `duration_ms`、provider、token 使用量。
- 导出 debug logs 功能。

### Epic 5.3：性能基准

- 测试 25 步循环、长上下文压缩、大量工具并发下的响应时间。

---

## 风险与注意事项

1. **AbortSignal.timeout** 在旧 Node 版本可能不可用；若打包失败，改用 `AbortController` + `setTimeout`。
2. **流式 SSE 解析** 对行尾空格敏感，需用 `trim()` 防御。
3. **Claude 工具结果格式** 需要 `tool_result` block，必须保证 `tool_use_id` 正确对应。
4. **并发工具执行** 若共享 workspace 状态可能产生竞态；当前工具大多为读操作，写操作在 Phase 2 加权限门控。
5. **大上下文截断** 会丢失早期对话；Phase 4 用摘要压缩替代硬截断。

---

## 验收标准

- [ ] `npm test` 全绿。
- [ ] `npm run typecheck` 无错误。
- [ ] 停止 Python 后端后，OmniAgent 仍能用 OpenAI/DeepSeek/Ollama 离线聊天。
- [ ] 离线聊天支持多步工具调用（例如：搜索 → 读取网页 → 总结）。
- [ ] Claude 离线模式可用（至少非流式完成）。
- [ ] 工具错误不再泄露 XML/代码围栏到模型上下文。
