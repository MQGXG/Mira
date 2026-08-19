# OmniAgent TypeScript Agent Core 后续阶段实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在已完成 Phase 1 的基础上，继续落地 Phase 2–5：权限门控、Skill/指令上下文、记忆持久化、质量可观测性，并补充未来扩展项，使 OmniAgent TS Core 达到生产级 Agent 桌面应用水平。

**Architecture:** 保持 `electron/agent-core/` 作为核心运行时，前端 `ChatWindow` 通过统一事件流消费；Electron Store / SQLite 用于本地持久化；React 对话框处理权限与问题确认；Skill 目录采用 Hermes 式 `~/.config/omniagent/skills/<category>/<skill>/SKILL.md` 结构。

**Tech Stack:** TypeScript, Electron IPC, React, Zod, electron-store/better-sqlite3, Vitest。

---

## 已完成的 Phase 1 状态

- ✅ Vitest 框架 + 8 个测试
- ✅ 多 Provider LLM 客户端（OpenAI/DeepSeek/Ollama/Anthropic/Custom）
- ✅ 流式 ReAct 循环 + 并发工具执行
- ✅ 消息修复 + 上下文截断
- ✅ 工具错误清洗 + 参数强制转换
- ✅ ChatWindow 离线流式接入
- ✅ 9 个默认工具注册并验证可用

---

## Phase 2：权限门控（Permission Gate）

### 目标
把现有 `electron/agent-core/permission.ts` 的 `ask` 效果真正接入 Agent 循环，用户每次执行写/危险操作前必须确认，并支持“始终允许”规则持久化。

### Task 2.1：扩展权限事件与 Agent 循环中断

**Files:**
- Modify: `electron/agent-core/types.ts`
- Modify: `electron/agent-core/agent.ts`
- Create: `electron/agent-core/__tests__/permission-loop.test.ts`

**实现要点：**

1. 在 `AgentEvent` 中已有 `permission_request`，现在让 Agent 在工具调用前检查权限。
2. `Agent` 实例维护一个 `pendingPermissions: Map<string, { resolve, reject }>`。
3. 当 `permissions.needsApproval(action, permission)` 为 true 时：
   - yield `permission_request` 事件
   - 暂停工具执行
   - 等待 `agent.replyPermission(id, 'allow' | 'deny' | 'always')`
4. 若 deny，工具结果返回错误；若 allow/always，继续执行；always 则持久化规则。

关键代码：

```typescript
// electron/agent-core/agent.ts
export class Agent {
  private pendingPermissions = new Map<string, { resolve: (allow: boolean) => void }>()

  async replyPermission(id: string, reply: 'allow' | 'deny' | 'always'): Promise<void> {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return
    if (reply === 'always') {
      // 持久化在 PermissionSet 或外部 store 中处理
      await this.savePermissionRule?.(id)
    }
    pending.resolve(reply !== 'deny')
    this.pendingPermissions.delete(id)
  }

  private async executeWithPermission(
    call: NonNullable<LLMMessage['tool_calls']>[number],
    ctx: ToolContext,
    permissions: PermissionSet,
  ): Promise<ToolResult> {
    const def = this.registry.get(call.function.name)
    const action = def?.permission || call.function.name
    if (!permissions.needsApproval(action, def?.permission)) {
      const { result } = await this.registry.materialize(permissions).settle(
        { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') },
        ctx,
      )
      return result
    }

    const requestID = `per_${call.id}`
    const promise = new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(requestID, { resolve })
    })

    // 通知前端
    this.eventQueue.push({
      type: 'permission_request',
      id: requestID,
      action,
      resources: [ctx.workspace],
      toolCall: { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') },
    })

    const allowed = await promise
    if (!allowed) {
      return { success: false, error: `Permission denied: ${action}` }
    }
    const { result } = await this.registry.materialize(permissions).settle(
      { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}') },
      ctx,
    )
    return result
  }
}
```

**注意：** Agent 当前是 generator，需要在 generator 内部等待权限 Promise。由于 generator 内 `await` 会挂起 generator，这是可行的。

**测试：**

```typescript
// electron/agent-core/__tests__/permission-loop.test.ts
import { expect, test } from 'vitest'
import { Agent } from '../agent'
import { createDefaultRegistry } from '../index'
import { PermissionSet } from '../permission'
import { make } from '../tool'
import { z } from 'zod'

const touchTool = make({
  name: 'touch',
  description: 'touch file',
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.string(),
  execute: async () => ({ success: true, output: 'touched' }),
  permission: 'write',
})

test('agent asks permission before write tool', async () => {
  const registry = createDefaultRegistry()
  registry.register(touchTool)
  const agent = new Agent(registry)
  const permissions = new PermissionSet([
    { action: 'write', resource: '*', effect: 'ask' },
  ])

  const gen = agent.run('touch test.txt', [], {
    sessionID: 's1',
    workspace: process.cwd(),
    model: 'gpt-4o-mini',
    apiKey: 'x',
    apiUrl: 'https://api.openai.com/v1',
    permissions,
  })

  let permissionEvent: any = null
  for await (const evt of gen) {
    if (evt.type === 'permission_request') {
      permissionEvent = evt
      await agent.replyPermission(evt.id, 'allow')
    }
    if (evt.type === 'finish') break
  }

  expect(permissionEvent).not.toBeNull()
  expect(permissionEvent.action).toBe('write')
})
```

---

### Task 2.2：前端 PermissionDialog 接入 Agent 事件流

**Files:**
- Modify: `src/components/chat/ChatWindow.tsx`
- Modify: `src/components/chat/PermissionDialog.tsx`（若存在则修改，否则创建）
- Modify: `electron/preload.ts`
- Modify: `electron/agent-core/ipc-bridge.ts`

**实现要点：**

1. `PermissionDialog.tsx` 显示工具名、参数、workspace、action，提供「允许一次 / 始终允许 / 拒绝」按钮。
2. `ChatWindow` 收到 `permission_request` 事件时打开对话框，阻塞后续消息渲染直到用户选择。
3. 用户选择后调用 `window.electronAPI.replyPermission(id, reply)`。
4. IPC 桥把回复路由到对应 `Agent` 实例。

由于 `run-agent-stream` 当前返回事件数组，Phase 2 需要改为实时事件通道（MessageChannel 或 `ipcRenderer.on` 事件）。这里采用更简单的方式：

- 主进程为每个 stream 创建一个唯一 channel ID
- 渲染进程通过 `ipcRenderer.on(channelID, (event) => ...)` 接收实时事件
- 权限回复也通过该 channel 返回

为降低复杂度，Phase 2 可以先保留数组返回，但在数组中遇到 `permission_request` 时前端弹出对话框，用户确认后继续消费后续事件。问题是后续事件可能已生成并包含未授权执行结果，因此**必须改为实时通道**。

**简化方案：** 用 `ipcMain.on` + `event.sender.send` 实现请求-回复。

```typescript
// electron/agent-core/ipc-bridge.ts
import { ipcMain, BrowserWindow } from 'electron'

const activeAgents = new Map<string, Agent>()

export function registerAgentIPCHandlers(): void {
  // ... existing handlers ...

  ipcMain.handle('agent:runStream', async (event, sessionId: string, message: string, config: AgentConfig) => {
    const agent = new Agent(registry)
    activeAgents.set(sessionId, agent)
    const sender = event.sender

    try {
      for await (const evt of agent.run(message, [], { ...config, sessionID: sessionId })) {
        sender.send(`agent:stream:${sessionId}`, evt)

        if (evt.type === 'permission_request') {
          // 等待前端回复
          await new Promise<void>((resolve) => {
            const handler = (_: any, reply: { id: string; reply: 'allow' | 'deny' | 'always' }) => {
              if (reply.id !== evt.id) return
              agent.replyPermission(reply.id, reply.reply)
              ipcMain.removeListener(`agent:permissionReply:${sessionId}`, handler)
              resolve()
            }
            ipcMain.on(`agent:permissionReply:${sessionId}`, handler)
          })
        }
      }
    } catch (e) {
      sender.send(`agent:stream:${sessionId}`, { type: 'error', message: String(e) })
    } finally {
      activeAgents.delete(sessionId)
    }
    sender.send(`agent:stream:${sessionId}`, { type: 'done' })
  })

  ipcMain.on('agent:permissionReply', (_, sessionId: string, reply: { id: string; reply: 'allow' | 'deny' | 'always' }) => {
    // forward to stream handler
  })
}
```

前端：

```typescript
// src/components/chat/ChatWindow.tsx
useEffect(() => {
  if (!isOfflineMode) return
  const channel = `agent:stream:${sessionId}`
  const handler = (_: any, event: AgentEvent) => {
    if (event.type === 'permission_request') {
      setPermissionReq(event)
      return
    }
    // ... handle other events ...
  }
  window.electronAPI.on(channel, handler)
  return () => window.electronAPI.off(channel, handler)
}, [isOfflineMode, sessionId])
```

---

### Task 2.3：持久化权限规则

**Files:**
- Create: `electron/agent-core/permission-store.ts`
- Modify: `electron/agent-core/permission.ts`
- Modify: `electron/agent-core/agent.ts`

**实现要点：**

1. 使用 `electron-store` 保存每个项目/工作区的权限规则。
2. `PermissionStore` 接口：`loadRules(workspace: string): PermissionRule[]`、`saveRule(workspace, rule)`。
3. Agent 启动时加载已保存规则，与 `defaultPermissions` 合并。
4. 用户选择「始终允许」时保存规则。

```typescript
// electron/agent-core/permission-store.ts
import Store from 'electron-store'

interface PermissionStoreSchema {
  permissions: Record<string, Array<{ action: string; resource: string; effect: 'allow' | 'deny' }>>
}

const store = new Store<PermissionStoreSchema>({
  name: 'permissions',
  defaults: { permissions: {} },
})

export function loadWorkspacePermissions(workspace: string) {
  return store.get(`permissions.${workspace}`) || []
}

export function saveWorkspacePermission(
  workspace: string,
  rule: { action: string; resource: string; effect: 'allow' | 'deny' },
) {
  const existing = loadWorkspacePermissions(workspace)
  store.set(`permissions.${workspace}`, [...existing.filter(r => r.action !== rule.action || r.resource !== rule.resource), rule])
}
```

---

## Phase 3：Skill 与指令上下文

### 目标
自动加载全局和项目级 `AGENTS.md`，并实现 Hermes 式 Skill 目录与 `/skill-name` slash 命令。

### Task 3.1：自动加载 AGENTS.md

**Files:**
- Create: `electron/agent-core/instruction-context.ts`
- Modify: `electron/agent-core/agent.ts`
- Create: `electron/agent-core/__tests__/instruction-context.test.ts`

**实现要点：**

1. 从 `~/.config/omniagent/AGENTS.md` 加载全局指令。
2. 从 `workspace` 向上查找到项目根目录（遇到 `.git` 或盘符停止），加载所有 `AGENTS.md`。
3. 将内容拼接进 system prompt。

```typescript
// electron/agent-core/instruction-context.ts
import { app } from 'electron'
import { join, dirname, isAbsolute, sep } from 'path'
import fs from 'fs'

export function findProjectRoot(start: string): string {
  let current = start
  while (current !== dirname(current)) {
    if (fs.existsSync(join(current, '.git'))) return current
    current = dirname(current)
  }
  return start
}

export function loadInstructionContext(workspace: string): string {
  const globalPath = join(app.getPath('userData'), 'AGENTS.md')
  const projectRoot = findProjectRoot(workspace)
  const files: string[] = []

  if (fs.existsSync(globalPath)) files.push(globalPath)

  let current = workspace
  while (current.startsWith(projectRoot) || current === projectRoot) {
    const p = join(current, 'AGENTS.md')
    if (fs.existsSync(p)) files.push(p)
    if (current === projectRoot) break
    current = dirname(current)
  }

  return files
    .map((p) => `Instructions from: ${p}\n${fs.readFileSync(p, 'utf-8')}`)
    .join('\n\n')
}
```

---

### Task 3.2：Skill 目录结构

**Files:**
- Create: `electron/agent-core/skill/skill-loader.ts`
- Create: `electron/agent-core/skill/skill-commands.ts`
- Create: `electron/agent-core/skill/skill-tool.ts`
- Modify: `electron/agent-core/index.ts`

**目录结构：**

```
~/.config/omniagent/skills/
├── software-development/
│   └── code-review/
│       ├── SKILL.md
│       └── references/
│           └── example.md
└── productivity/
    └── note-taking/
        └── SKILL.md
```

**SKILL.md 格式：**

```yaml
---
name: code-review
description: 帮助进行代码审查
version: 1.0.0
platforms: [windows, macos, linux]
---

# Code Review Skill

当你被要求进行代码审查时，请遵循以下步骤...
```

**实现要点：**

1. `skills_list` 工具：扫描目录，返回 `{ name, description, category }` 列表。
2. `skill_view(name)` 工具：加载完整 SKILL.md 内容。
3. `/skill-name` slash 命令：解析用户输入，构建 invocation message 注入到用户消息中。
4. 把 `skills_list` 和 `skill_view` 注册到默认工具注册表。

---

### Task 3.3：前端 slash 命令补全

**Files:**
- Modify: `src/components/chat/ChatInput.tsx`
- Modify: `src/components/chat/ChatWindow.tsx`

**实现要点：**

1. 用户输入 `/` 时显示可用 skill 列表。
2. 选择或继续输入后，将 `/skill-name` 转换为 skill invocation message 发送。
3. 也可以保留原样让 Agent 在 system prompt 中识别 slash 命令。

---

## Phase 4：记忆与持久化

### 目标
参考 Hermes `MemoryManager` 的 provider 架构，实现回合前 prefetch、回合后 sync，并持久化会话历史。

### Task 4.1：Memory Provider 架构

**Files:**
- Create: `electron/agent-core/memory/types.ts`
- Create: `electron/agent-core/memory/manager.ts`
- Create: `electron/agent-core/memory/builtin-provider.ts`
- Modify: `electron/agent-core/agent.ts`

**接口：**

```typescript
// electron/agent-core/memory/types.ts
export interface MemoryProvider {
  name: string
  initialize(sessionID: string, workspace: string): Promise<void>
  buildSystemPrompt(): string
  prefetch(query: string, sessionID: string): Promise<string>
  syncTurn(user: string, assistant: string, sessionID: string): Promise<void>
  getToolSchemas?(): Array<Record<string, unknown>>
  handleToolCall?(name: string, args: Record<string, unknown>): Promise<string>
  shutdown(): Promise<void>
}
```

**Manager：**

```typescript
// electron/agent-core/memory/manager.ts
export class MemoryManager {
  private providers: MemoryProvider[] = []

  addProvider(p: MemoryProvider) {
    this.providers.push(p)
  }

  async initialize(sessionID: string, workspace: string) {
    await Promise.all(this.providers.map(p => p.initialize(sessionID, workspace)))
  }

  buildSystemPrompt(): string {
    return this.providers.map(p => p.buildSystemPrompt()).filter(Boolean).join('\n\n')
  }

  async prefetch(query: string, sessionID: string): Promise<string> {
    const parts = await Promise.all(
      this.providers.map(async p => {
        try { return await p.prefetch(query, sessionID) } catch { return '' }
      }),
    )
    return parts.filter(Boolean).join('\n\n')
  }

  async syncTurn(user: string, assistant: string, sessionID: string) {
    // 后台执行，不阻塞
    Promise.all(
      this.providers.map(async p => {
        try { await p.syncTurn(user, assistant, sessionID) } catch { /* log */ }
      }),
    )
  }
}
```

**内置 Provider：**

- 使用 `better-sqlite3` 或 Electron Store 保存用户偏好、关键决策、文件修改记录。
- `prefetch` 根据当前查询做向量/关键词召回（Phase 4 先做关键词，Phase 5 加 embedding）。

---

### Task 4.2：会话持久化

**Files:**
- Create: `electron/agent-core/session-store.ts`
- Modify: `electron/agent-core/agent.ts`
- Modify: `src/components/chat/ChatWindow.tsx`

**实现要点：**

1. 使用 SQLite 保存每条会话消息（role, content, tool_calls, timestamp）。
2. Agent 启动时加载历史消息。
3. 每条 assistant/tool 消息生成后写入数据库。
4. 前端支持切换/恢复历史会话。

---

### Task 4.3：把 Memory 接入 Agent 循环

**实现要点：**

1. Agent `run` 开始时调用 `memoryManager.initialize`。
2. system prompt 拼接 `memoryManager.buildSystemPrompt()`。
3. 每次用户消息前，调用 `memoryManager.prefetch` 并把结果注入 user message。
4. 每个 turn 结束后调用 `memoryManager.syncTurn`。

---

## Phase 5：质量与可观测性

### Task 5.1：Provider 降级链

**Files:**
- Create: `electron/agent-core/failover.ts`
- Modify: `electron/agent-core/llm-client.ts`
- Modify: `electron/agent-core/agent.ts`

**实现要点：**

1. 配置支持 `fallbacks: ClientConfig[]`。
2. 主 provider 失败时（网络错误、429、401/403 排除），按顺序尝试 fallback。
3. 记录每次降级事件并通知前端。

---

### Task 5.2：日志与审计

**Files:**
- Create: `electron/agent-core/logger.ts`
- Modify: 所有工具文件
- Modify: `electron/agent-core/agent.ts`

**实现要点：**

1. 每个工具调用记录 `duration_ms`、输入参数摘要、结果状态、token 使用量。
2. 日志写入 `~/.config/omniagent/logs/agent-YYYY-MM-DD.log`。
3. 提供 IPC handler 导出 debug logs（与 OpenCode 对齐）。

---

### Task 5.3：性能基准

**Files:**
- Create: `electron/agent-core/__tests__/benchmark.test.ts`

**实现要点：**

1. 25 步循环不崩溃测试。
2. 长上下文（>8000 tokens）截断后仍正常响应。
3. 10 个工具并发执行在 5 秒内完成。

---

## 还有哪些值得做的扩展项

除了计划中的 5 个 Phase，参考 Learn Claude Code / Hermes / OpenCode，以下高价值能力也值得后续加入：

### Phase 6：Subagent / 多智能体协作

- 实现 `delegate_task` 工具，启动子 Agent 处理独立子任务。
- 子 Agent 继承父 Agent 权限子集，拥有独立 session ID。
- 参考 Hermes `delegate_tool` 与 OpenCode `subagent-permissions`。

### Phase 7：Background Tasks / Cron

- 用户可要求 Agent 定时执行任务（例如每天 9 点检查 GitHub issues）。
- 使用 `node-cron` 或 Electron 的 `setInterval` + 持久化任务队列。
- 参考 Learn Claude Code 第 14 章。

### Phase 8：上下文摘要压缩（Context Compaction）

- 简单截断会丢失早期上下文。
- 实现一个 `compact_context` 工具：用 LLM 把长对话总结成摘要，替换早期消息。
- 参考 OpenCode `SessionCompaction` 与 Hermes `context_compressor.py`。

### Phase 9：MCP 集成

- 支持 Model Context Protocol servers。
- 动态加载外部 MCP 工具，与现有 ToolRegistry 合并。
- 参考 Hermes `tools/mcp_tool.py`。

### Phase 10：自动标题生成与会话管理

- 每个会话第一条消息后，用 LLM 生成标题。
- 前端会话列表显示标题而非 session ID。
- 支持删除/重命名/导出会话。

### Phase 11：Worktree / Git 隔离

- 在执行大量文件修改前自动创建 git worktree 或分支。
- 失败后一键回滚。
- 参考 Learn Claude Code 第 18 章。

### Phase 12：LSP / IDE 集成

- 通过 LSP 获取代码符号、诊断、补全。
- 与 Hermes `agent/lsp/` 对齐。

---

## 推荐执行顺序

考虑到当前 OmniAgent 最痛的点是「后端离线时无法使用」和「工具调用不可控」，推荐顺序：

1. **Phase 2 权限门控**（立刻提升安全性，避免写文件误操作）
2. **Phase 3 Skill 与指令上下文**（提升 Agent 专业能力和一致性）
3. **Phase 4 记忆与持久化**（让 Agent 有长期记忆，会话可恢复）
4. **Phase 5 质量与可观测性**（生产级可靠性）
5. **Phase 8 上下文摘要压缩**（替代硬截断，提升长对话质量）
6. **Phase 10 自动标题与会话管理**（提升 UI 体验）
7. 其他 Phase 按需实施

---

## 验收标准（Phases 2-5）

- [ ] 写文件/执行命令前弹出 PermissionDialog，用户拒绝则取消执行。
- [ ] 「始终允许」的规则持久化，重启后仍然生效。
- [ ] 自动加载全局和项目级 `AGENTS.md`。
- [ ] 支持 `/skill-name` slash 命令调用 Skill。
- [ ] Agent 能根据记忆内容回答跨会话相关问题。
- [ ] 会话历史持久化，重启应用后可恢复。
- [ ] Provider 失败时自动尝试 fallback。
- [ ] 工具调用日志包含 duration_ms、状态、token 使用量。
- [ ] `npm test` 全绿，`npm run typecheck` 无错误。
