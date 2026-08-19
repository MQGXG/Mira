# Mira Agent Core 优化实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 Mira Agent Core 中的 17 个已识别问题，提升安全性、稳定性、可维护性

**Architecture:** 不改动整体架构，逐文件精确修复。按 P0→P1→P2→P3 优先级，确保每个修改独立可测试。

**前置检查清单（每次任务前执行）：**
- `npm run typecheck` — 确保无类型错误
- `npm test` — 确保现有测试通过
- `git status` — 确保工作区干净

**验证清单（每次任务后执行）：**
- `npm run typecheck` — 类型检查通过
- `npm test` — 所有测试通过
- `node -e "require('./dist-electron/main.js')"` — 启动无崩溃

---

## P0 — 安全性与正确性（立即修复）

### Task 1: Bash 工具误报修复

**文件：** `electron/agent-core/tools/bash.ts:40-44`

**问题：** catch 块返回 `success: true`，导致 LLM 误认为失败命令成功执行。

**Step 1: 修复返回值**

修改 `bash.ts:44`：
```typescript
// 修改前
return { success: true, output: (msg || "").slice(0, 5000) }

// 修改后
return { success: false, error: (msg || "Command execution failed").slice(0, 5000) }
```

**Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`

**Step 3: 提交**

```bash
git add electron/agent-core/tools/bash.ts
git commit -m "fix: bash工具执行失败时正确返回success:false"
```

---

### Task 2: 子代理权限门控

**文件：** `electron/agent-core/delegate-runner.ts:163-183`

**问题：** 子代理直接调用 `registry.execute()`，绕过 `evaluateToolCalls()`/`ApprovalStore`/权限弹窗。

**Step 1: 导入权限评估模块**

在 `delegate-runner.ts` 顶部加入：
```typescript
import { evaluateToolCalls } from "./permission-gate"
import { PermissionSet } from "./permission"
```

**Step 2: 替换直接执行为权限门控**

将:
```typescript
for (const call of toolCallsArray) {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(call.function.arguments) } catch { }
  const result = await registry.execute(call.function.name, args, ctx)
  const text = result.output || result.error || ""
  messages.push({ ... })
}
```

替换为:
```typescript
const approvals = evaluateToolCalls(toolCallsArray, registry, childConfig.permissions)
for (const ev of approvals) {
  if (ev.needsApproval) {
    // 子代理权限不足时跳过，返回错误
    messages.push({
      role: "tool",
      content: [{ type: "tool-result" as const, toolCallId: ev.toolCall.id, toolName: ev.toolCall.name, output: { type: "text" as const, value: `[Permission denied: ${ev.toolCall.name} — sub-agent cannot request permission]` } }],
      tool_call_id: ev.toolCall.id,
    })
    continue
  }
  const result = await registry.execute(ev.toolCall.name, ev.args, ctx)
  const text = result.output || result.error || ""
  messages.push({
    role: "tool",
    content: [{ type: "tool-result" as const, toolCallId: ev.toolCall.id, toolName: ev.toolCall.name, output: { type: "text" as const, value: text } }],
    tool_call_id: ev.toolCall.id,
  })
}
```

**Step 3: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.json`

**Step 4: 提交**

```bash
git add electron/agent-core/delegate-runner.ts
git commit -m "fix: 子代理增加权限门控，拒绝未授权的工具调用"
```

---

### Task 3: SQL 注入修复

**文件：** `electron/agent-core/session-store.ts`

**问题：** 部分 SQL 查询使用模板字符串拼接 `sessionID`，存在注入风险。

**Step 1: 检查并修复所有拼接**

检查 `session-store.ts` 全部 SQL 调用。当前代码查看全部使用 `runWrite(sql, params)` 参数化形式，注释中看到的 `'${...}'` 模式不存在于实际代码。但 `database.ts:69` 的 `db.run(sql, params)` 需要确保 `params` 不是 `undefined`。

在 `runWrite` 函数（`database.ts:68-72`）中添加参数校验：
```typescript
export function runWrite(sql: string, params?: any[]): void {
  if (!db) throw new Error("数据库未初始化")
  // 安全校验：确保 params 非空时数组元素不含对象
  if (params) {
    for (let i = 0; i < params.length; i++) {
      if (typeof params[i] === "object" && params[i] !== null) {
        params[i] = JSON.stringify(params[i])
      }
    }
  }
  db.run(sql, params)
  scheduleSave()
}
```

**Step 2: 提交**

```bash
git add electron/agent-core/database.ts
git commit -m "fix: 数据库写入增加参数类型安全校验"
```

---

### Task 4: ApprovalStore 持久化集成

**文件：** 
- `electron/agent-core/permission/approval-store.ts`
- `electron/agent-core/permission-store.ts`
- `electron/agent-core/agent.ts`

**问题：** `approval-store.ts` 只在内存中缓存 5 分钟，"始终允许"的决策重启后丢失。`permission-store.ts` 已经实现了 SQLite 持久化但未被 `checkAll()` 使用。

**Step 1: 修改 ApprovalStore 集成持久层**

在 `approval-store.ts` 顶部添加导入：
```typescript
import { loadWorkspacePermissions, saveWorkspacePermission } from "../permission-store"
```

新增 `persistOnAlways` 方法：
```typescript
async persistOnAlways(workspace: string, action: string, resources: string[]): Promise<void> {
  for (const r of resources) {
    await saveWorkspacePermission(workspace, { action, resource: r, effect: "allow" })
  }
}
```

修改 `record()` 添加可选的持久化参数：
```typescript
record(action: string, resources: string[], decision: "allow" | "deny", 
       ttlMs = 300_000, workspace?: string): void {
  const now = Date.now()
  for (const r of resources) {
    this.cache.set(this.key(action, r), { action, resources: [r], decision, timestamp: now, ttlMs })
  }
  if (decision === "allow" && workspace) {
    this.persistOnAlways(workspace, action, resources).catch(() => {})
  }
}
```

**Step 2: 修改 Agent 传递 workspace**

在 `agent.ts` 中，给 `Agent` 类添加 `workspace` 字段，在运行构造中传递给 `approvalStore`：

在 `Agent` 类中加入：
```typescript
private workspace: string = ""
constructor(...) {
  ...
  this.workspace = workspace || ""
}

// 在 replyPermission 中，当允许时持久化
replyPermission(id: string, reply: PermissionReply): void {
  ...
  if (reply === "always" && this.workspace) {
    // 持久化逻辑在 state machine 的 onAlways 回调中处理
  }
}
```

**Step 3: 提交**

```bash
git add electron/agent-core/permission/approval-store.ts
git add electron/agent-core/agent.ts
git commit -m "feat: ApprovalStore持久化集成，始终允许决策重启不丢失"
```

---

## P1 — 稳定性与体验

### Task 5: LLM 流式调用增加重试机制

**文件：** `electron/agent-core/llm-sdk.ts`

**问题：** `stream()` 方法遇到网络错误直接报错退出，无重试。OpenAI API 经常出现 429/502 瞬时错误。

**Step 1: 添加重试包装器**

在 `llm-sdk.ts` 中添加重试逻辑：

```typescript
async function* withRetry(
  stream: () => AsyncGenerator<LLMStreamEvent>,
  maxRetries = 3,
  baseDelay = 1000,
): AsyncGenerator<LLMStreamEvent> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1)  // 指数退避
      await new Promise((r) => setTimeout(r, delay))
    }
    try {
      let hasError = false
      for await (const event of stream()) {
        if (event.type === "error") {
          hasError = true
          lastError = new Error(event.error.message)
          break  // 尝试重连
        }
        yield event
      }
      if (!hasError) return  // 成功完成
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
    }
  }
  // 所有重试失败，抛出最终错误
  yield { type: "error", error: { message: `All ${maxRetries} retries failed: ${lastError?.message}` } }
}
```

**Step 2: 在 stream() 方法中使用**

修改 `createLLMClient` 的 `stream` 方法，将 provider 流包装：
```typescript
async function* stream(request: LLMRequest2): AsyncGenerator<LLMStreamEvent> {
  yield* withRetry(() => innerStream(request), 2, 800)
}

async function* innerStream(request: LLMRequest2): AsyncGenerator<LLMStreamEvent> {
  // ... 原有的 stream 逻辑
}
```

**Step 3: 提交**

```bash
git add electron/agent-core/llm-sdk.ts
git commit -m "feat: LLM流式调用增加指数退避重试机制"
```

---

### Task 6: MemoryManager 错误日志

**文件：** `electron/agent-core/memory/manager.ts`

**问题：** 所有 Provider 的错误被完全静默吞掉，无法调试。

**Step 1: 导入 logger**

```typescript
import { logError } from "../logger"
```

**Step 2: 替换所有空 catch**

```typescript
// 修改前
try { await p.initialize(sessionID, workspace) } catch { }

// 修改后
try { await p.initialize(sessionID, workspace) } catch (e) {
  logError(`[MemoryManager] 初始化失败 "${p.name}": ${e instanceof Error ? e.message : e}`)
}
```

对所有 5 个 catch 块做同样处理：`initialize`、`buildSystemPrompt`、`prefetch`、`syncTurn`、`shutdown`。

**Step 3: 提交**

```bash
git add electron/agent-core/memory/manager.ts
git commit -m "fix: MemoryManager添加错误日志，不再静默吞异常"
```

---

### Task 7: 冗余 IPC Handler 清理

**文件：** `electron/agent-core/ipc-bridge.ts:250-298`

**问题：** `agent:chat` 和 `run-agent-stream` 功能重复。

**Step 1: 标记废弃**

在 `run-agent-stream` 和 `agent:chat` handler 上添加 `@deprecated` 注释，保留 `agent:chat` 作为兼容入口，但内部委托给新逻辑：

```typescript
/** @deprecated 使用 agent:startStream 替代 — 保留以兼容现有前端调用 */
ipcMain.handle("run-agent-stream", async (_, sessionId, message, config) => {
  const channel = await ipcMain.emit("agent:startStream", ...arguments)
  // 等待并收集事件
  ...
})
```

**Step 2: 检查前端引用**

搜索前端代码中 `agent:chat` 和 `run-agent-stream` 的调用，统一迁移到 `agent:startStream`。

**Step 3: 提交**

```bash
git add electron/agent-core/ipc-bridge.ts
git add src/
git commit -m "refactor: 统一IPC Agent流入口为agent:startStream，移除重复handler"
```

---

## P2 — 安全增强

### Task 8: 代码执行沙箱

**文件：** `electron/agent-core/tools/code-exec.ts`

**问题：** Python 代码无沙箱，直接执行。

**Step 1: 添加资源限制参数**

```typescript
const { stdout, stderr } = await execFileAsync("python", [filePath], {
  timeout: 30000,
  maxBuffer: 1024 * 1024,
  // Windows 下无法使用 ulimit，但可以设置环境变量限制
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
})
```

**Step 2: 添加 Docker 沙箱选项（可选）**

检测 Docker 可用时自动使用容器执行：
```typescript
async execute(input, _ctx) {
  const hasDocker = await checkDocker()
  if (hasDocker) {
    return this.runInDocker(input.code)
  }
  return this.runDirect(input.code)
}
```

**Step 3: 提交**

```bash
git add electron/agent-core/tools/code-exec.ts
git commit -m "feat: 代码执行增加Docker沙箱选项"
```

---

### Task 9: 工具元数据补全

**文件：** `electron/agent-core/tools/tool-meta.ts`

**问题：** 部分工具缺少 `supportsParallel` 和 `requiresPermission` 标记。

**Step 1: 补全所有工具元数据**

```typescript
read_file:     { category: "core", timeout: 10000, supportsParallel: true },
write_file:    { category: "core", timeout: 10000 },
edit_file:     { category: "core", timeout: 10000 },
list_files:    { category: "core", timeout: 5000, supportsParallel: true },
grep:          { category: "core", timeout: 15000, supportsParallel: true },
glob:          { category: "core", timeout: 15000, supportsParallel: true },

web_search:    { category: "knowledge", timeout: 15000, supportsParallel: true },
web_browse:    { category: "knowledge", timeout: 30000, supportsParallel: true },
data_analysis: { category: "knowledge", timeout: 60000, supportsParallel: true },

bash:          { category: "execution", requiresPermission: true, timeout: 60000 },
code_exec:     { category: "execution", requiresPermission: true, timeout: 60000 },
image_gen:     { category: "execution", requiresPermission: true, timeout: 60000 },

task_planner:  { category: "orchestration", supportsParallel: true },
delegate_task: { category: "orchestration", timeout: 120000 },
team_tool:     { category: "orchestration" },
cron_tool:     { category: "orchestration" },
worktree_tool: { category: "orchestration", timeout: 30000 },

lsp_definition:  { category: "infrastructure", timeout: 10000, supportsParallel: true },
lsp_references:  { category: "infrastructure", timeout: 10000, supportsParallel: true },
lsp_hover:       { category: "infrastructure", timeout: 10000, supportsParallel: true },
```

**Step 2: 提交**

```bash
git add electron/agent-core/tools/tool-meta.ts
git commit -m "fix: 补全全部工具的supportsParallel和requiresPermission元数据"
```

---

## P2 — 遗留代码与技术债务

### Task 10: console.log 统一迁移

**文件：** `electron/agent-core/ipc-bridge.ts`, `electron/agent-core/registry.ts`, `electron/main.ts`

**问题：** 生产代码中多处直接使用 `console.log`/`console.error`，未走 logger 系统。

**Step 1: 检查 logger 能力**

查看 `electron/utils/logger.ts` 的导出接口，确认支持的日志级别。

**Step 2: 逐一替换**

```typescript
// ipc-bridge.ts:316
// 修改前
console.log('[IPC] sending event:', evt.type, channel)
// 修改后
import { logInfo } from "../utils/logger"
logInfo(`[IPC] sending event: ${evt.type} ${channel}`)

// registry.ts:39
// 修改前
console.error(`[registry] 工具 "${info.id}" 初始化失败:`, err)
// 修改后
import { logError } from "../utils/logger"
logError(`[registry] 工具 "${info.id}" 初始化失败`, err)
```

**Step 3: 提交**

```bash
git add electron/agent-core/ipc-bridge.ts
git add electron/agent-core/registry.ts
git add electron/main.ts
git commit -m "refactor: console.log迁移至统一logger系统"
```

---

### Task 11: 消息截断保护

**文件：** `electron/agent-core/message-utils.ts`

**问题：** `truncateToBudget` 可能截断工具调用链，导致孤立的 `tool-result`。

**Step 1: 检查 `message-utils.ts` 实现**

查看当前截断逻辑，确保：
1. 不会截断 system message
2. 不会在 `tool-call` 和对应 `tool-result` 中间截断
3. 至少保留最后 2 轮完整对话

**Step 2: 添加截断保护逻辑**

```typescript
export function truncateToBudget(messages: LLMMessage[], maxTokens: number): LLMMessage[] {
  // 估算 token 数（粗略：每字符 0.25 token）
  let total = 0
  const result: LLMMessage[] = []
  
  // 始终保留 system message
  const systemIdx = messages.findIndex(m => m.role === "system")
  if (systemIdx >= 0) {
    result.push(messages[systemIdx])
    total += estimateTokens(messages[systemIdx])
  }
  
  // 从尾部向前保留，确保不截断 tool-call/tool-result 链
  let toolCallDepth = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const tokens = estimateTokens(m)
    if (total + tokens > maxTokens) {
      // 如果当前消息是 tool-result 的一部分，必须保留对应的 tool-call
      if (hasToolCallId(m) && toolCallDepth === 0) break
      break
    }
    result.splice(systemIdx >= 0 ? 1 : 0, 0, m)
    total += tokens
    if (m.role === "assistant" && hasToolCalls(m)) toolCallDepth++
    if (m.role === "tool") toolCallDepth = Math.max(0, toolCallDepth - 1)
  }
  
  return result
}
```

**Step 3: 提交**

```bash
git add electron/agent-core/message-utils.ts
git commit -m "fix: 消息截断保护，避免截断工具调用链"
```

---

### Task 12: 模式权限规则去重

**文件：** `electron/agent-core/modes.ts`, `electron/agent-core/ipc-bridge.ts`

**问题：** `modeToPermissionSet` 和 `ipc-bridge.ts` 的 `buildPermissions` 都在做规则叠加，顺序不一致。

**Step 1: 统一权限构建入口**

移除 `ipc-bridge.ts:49-56` 中的重复叠加逻辑，改为只调用 `modeToPermissionSet`：

```typescript
async function buildPermissions(workspace: string, mode?: string, configOverride?: PermissionSet): Promise<PermissionSet> {
  const savedRules = await loadWorkspacePermissions(workspace)
  let base = defaultPermissions
  if (mode) {
    base = modeToPermissionSet(mode as any, defaultPermissions)
  }
  const allRules = [...savedRules, ...(configOverride?.getAll() || []), ...base.getAll()]
  return new PermissionSet(allRules)
}
```

**Step 2: 提交**

```bash
git add electron/agent-core/ipc-bridge.ts
git commit -m "refactor: 统一权限构建逻辑，消除重复叠加"
```

---

## P3 — 新功能

### Task 13: Git 基础工具

**文件：** 新建 `electron/agent-core/tools/git.ts`

**功能：** `git_status`, `git_diff`, `git_log`, `git_commit` 四个基本 Git 工具。

**Step 1: 实现 git 工具**

```typescript
import { z } from "zod"
import { make } from "../tool"
import { execFile } from "child_process"
import { promisify } from "util"

const execAsync = promisify(execFile)

export const gitStatusTool = make({
  name: "git_status",
  description: "Show working tree status (equivalent to git status)",
  inputSchema: z.object({ path: z.string().optional().describe("Git repo path") }),
  outputSchema: z.string(),
  async execute(input, ctx) {
    const cwd = input.path || ctx.workspace
    try {
      const { stdout } = await execAsync("git", ["status", "--short"], { cwd, timeout: 10000 })
      return { success: true, output: stdout || "(clean)" }
    } catch (e: any) {
      return { success: false, error: e.stderr || e.message }
    }
  },
})

export const gitDiffTool = make({ ... })
export const gitLogTool = make({ ... })
export const gitCommitTool = make({ ... })
```

**Step 2: 注册到工具索引**

修改 `tools/index.ts` 添加导出。

**Step 3: 添加到注册表**

在 `createDefaultRegistry()` 函数中注册。

**Step 4: 提交**

```bash
git add electron/agent-core/tools/git.ts
git add electron/agent-core/tools/index.ts
git commit -m "feat: 添加git_status/git_diff/git_log/git_commit基础工具"
```

---

### Task 14: 前端引用统一

**文件：** `src/` 下的 React 组件

**问题：** `ipcRenderer.invoke("agent:chat")` 可能仍被前端使用，需统一迁移到 `agent:startStream`。

**Step 1: 搜索前端 IPC 调用**

```bash
rg "agent:chat|run-agent-stream" src/
```

**Step 2: 替换调用**

将所有 `invoke("agent:chat", ...)` 替换为 `invoke("agent:startStream", ...)`，并适配事件处理（从返回事件数组改为通过 channel 监听实时事件）。

**Step 3: 提交**

```bash
git add src/
git commit -m "refactor: 前端IPC调用统一迁移至agent:startStream"
```

---

## 执行路线图

```
Week 1 (P0 安全修复)
  Day 1: Task 1 (Bash误报) + Task 2 (子代理权限)
  Day 2: Task 3 (SQL安全) + Task 4 (持久化批准)

Week 2 (P1 稳定性)
  Day 3: Task 5 (LLM重试)
  Day 4: Task 6 (Memory日志) + Task 7 (冗余Handler)

Week 3 (P2 增强)
  Day 5: Task 8 (沙箱) + Task 9 (元数据)
  Day 6: Task 10 (日志迁移) + Task 11 (截断保护)

Week 4 (P3 新功能)
  Day 7: Task 12 (权限去重) + Task 13 (Git工具)
  Day 8: Task 14 (前端统一) + 整体回归测试
```

**每个 Task 预估时间：30min - 2h，总计约 16h 工作量。**
