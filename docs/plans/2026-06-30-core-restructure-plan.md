# core 包重构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 core/src 根目录从 47 个平铺 .ts 文件重构为按变化频率分组的模块化结构

**架构:** 变化频率分组 — 一起改的放一起。agent/、session/、config/、system/、shared/、tools/、task/、background/、orchestrate/ 九个模块子目录 + llm/、memory/、skill/、lsp/ 保留不动

**Tech Stack:** TypeScript, pnpm, vitest

**设计文档:** `docs/plans/2026-06-30-core-restructure-design.md`

---

### Task 0: 环境准备 & 基线确认

**Files:**
- Verify: `packages/core/src/` 目录
- Reference: `packages/core/src/index.ts`

**Step 1: 确认当前目录基线**

Run: `Get-ChildItem -LiteralPath "packages/core/src" -Name | Sort-Object`
Expected: 60 个 entry（47 .ts + 13 dirs）

**Step 2: 确认当前基线 tests 通过**

Run: `pnpm typecheck`
Expected: PASS

Run: `pnpm test`
Expected: PASS

**Step 3: 确认所有空壳目录仅含 index.ts**

Run: `Get-ChildItem -LiteralPath "packages/core/src/plugin" -Name`
Expected: `index.ts`

Run: `Get-ChildItem -LiteralPath "packages/core/src/mcp" -Name`
Expected: `index.ts`

Run: `Get-ChildItem -LiteralPath "packages/core/src/workflow" -Name`
Expected: `index.ts`

**Step 4: 确认 layers.ts 未被引用**

Run: `Select-String -Pattern "layers" -Path "packages/core/src/**/*.ts" -List`
Expected: 仅 index.ts 导出 layers 相关内容（如果有的话），无其他引用者

**Step 5: Commit**

```bash
git add .
git commit -m "chore: baseline before core restructure"
```

---

### Task 1: Phase 0 — 清理无风险项

**Files:**
- Delete: `packages/core/src/layers.ts`
- Maybe delete: `packages/core/src/plugin/index.ts`, `packages/core/src/mcp/index.ts`, `packages/core/src/workflow/index.ts`

**Step 1: 删除 layers.ts**

Run: `Remove-Item -LiteralPath "packages/core/src/layers.ts"`

**Step 2: 确认 index.ts 中无 layers 相关导出**

Read: `packages/core/src/index.ts` — 确认无 `layers` 相关行

**Step 3: 确认 mcp/、workflow/、plugin/ 可降级为单文件**

如果每个目录只有 `index.ts`：
Run: `Get-ChildItem -LiteralPath "packages/core/src/mcp" -Recurse`
Expected: 仅 `index.ts`
→ 查看 mcp/index.ts 内容。如果仅导出内容，将内容移到 `packages/core/src/mcp.ts`，删除 `mcp/` 目录。
→ 对 workflow/ 和 plugin/ 同样处理。

Run: `Select-String -Pattern "../mcp|../workflow|../plugin" -Path "packages/core/src/**/*.ts" -List`
→ 记录所有引用方，待更新路径。

**Step 4: 删除 layers.ts 的引用**

Run: `Select-String -Pattern "layers" -Path "packages/core/src/**/*.ts" -List`
Expected: 无结果（layers.ts 已删且无人引用）

**Step 5: Typecheck & Test**

```bash
pnpm typecheck
pnpm test
```

**Step 6: Commit**

```bash
git add .
git commit -m "refactor(core): remove layers.ts and empty shell directories"
```

---

### Task 2: Phase 1a — 创建 system/ 目录

**Files:**
- Move: `packages/core/src/database.ts` → `packages/core/src/system/database.ts`
- Move: `packages/core/src/logger.ts` → `packages/core/src/system/logger.ts`
- Move: `packages/core/src/registry.ts` → `packages/core/src/system/registry.ts`
- Move: `packages/core/src/registry-init.ts` → `packages/core/src/system/registry-init.ts`
- Move: `packages/core/src/permission.ts` → `packages/core/src/system/permission/index.ts`
- Move: `packages/core/src/permission-gate.ts` → `packages/core/src/system/permission/gate.ts`
- Move: `packages/core/src/permission-store.ts` → `packages/core/src/system/permission/store.ts`
- Move: `packages/core/src/permission/` → `packages/core/src/system/permission/`（合并）
- Move: `packages/core/src/server-manager.ts` → `packages/core/src/system/server-manager.ts`
- Move: `packages/core/src/server/` → `packages/core/src/system/server/`
- Move: `packages/core/src/instruction-context.ts` → `packages/core/src/system/instruction.ts`
- Modify: 所有引用方 import 路径

**Step 1: 创建 system/ 目录结构**

```bash
New-Item -ItemType Directory -Path "packages/core/src/system" -Force
New-Item -ItemType Directory -Path "packages/core/src/system/permission" -Force
New-Item -ItemType Directory -Path "packages/core/src/system/server" -Force
```

**Step 2: git mv 所有相关文件**

```bash
git mv packages/core/src/database.ts packages/core/src/system/database.ts
git mv packages/core/src/logger.ts packages/core/src/system/logger.ts
git mv packages/core/src/registry.ts packages/core/src/system/registry.ts
git mv packages/core/src/registry-init.ts packages/core/src/system/registry-init.ts
git mv packages/core/src/permission.ts packages/core/src/system/permission/index.ts
git mv packages/core/src/permission-gate.ts packages/core/src/system/permission/gate.ts
git mv packages/core/src/permission-store.ts packages/core/src/system/permission/store.ts
# permission/ 目录内有 approval-store.ts，一起移
git mv packages/core/src/permission/approval-store.ts packages/core/src/system/permission/approval-store.ts
Remove-Item -LiteralPath "packages/core/src/permission" -Recurse
git mv packages/core/src/server-manager.ts packages/core/src/system/server-manager.ts
git mv packages/core/src/server/*.ts packages/core/src/system/server/
Remove-Item -LiteralPath "packages/core/src/server" -Recurse
git mv packages/core/src/instruction-context.ts packages/core/src/system/instruction.ts
```

**Step 3: 更新所有内部 import 路径**

对每个被移动的文件，更新其内部 import 从旧相对路径到新相对路径。
例如 `database.ts` 中如果有 `import { logger } from "./logger"` → `"../system/logger"` 不对，实际上 database.ts 现在在 system/ 下，所以 `"../system"` 同级变成 `"./logger"`。

关键检查点 — 对外暴露的 import：
- `index.ts` 如果 `export { initDatabase } from "./database"` → `"./system/database"`
- `electron` 或 `ui` 中如果有 `from "@mira/core/database"` 则需改

**Step 4: 更新 index.ts 中的导出路径**

Read: `packages/core/src/index.ts`
找到所有指向被移文件的导出，更新路径。

**Step 5: 全局搜索需要更新的引用**

Run: `Select-String -Pattern "from \"\.\./database\"|from \"\.\/database\"|from \"\./logger\"|from \"\./registry\"|from \"\./permission\"|from \"\./permission-gate\"|from \"\./permission-store\"|from \"\./instruction-context\"|from \"\./server-manager\"|from \"\./server\"" -Path "packages/core/src/**/*.ts" -List`

逐一确认每个引用是否需要更新。

**Step 6: Typecheck**

```bash
pnpm typecheck
```
修复所有错误，直到 PASS。

**Step 7: Test**

```bash
pnpm test
```

**Step 8: Commit**

```bash
git add .
git commit -m "refactor(core): move system-level modules to system/"
```

---

### Task 3: Phase 1b — 创建 shared/ 目录

**Files:**
- Move: `packages/core/src/tool.ts` → `packages/core/src/shared/tool.ts`
- Move: `packages/core/src/tool-effect.ts` → `packages/core/src/shared/tool-effect.ts`
- Move: `packages/core/src/tool-executor.ts` → `packages/core/src/shared/tool-executor.ts`
- Move: `packages/core/src/message-utils.ts` → `packages/core/src/shared/message-utils.ts`
- Move: `packages/core/src/zod-converter.ts` → `packages/core/src/shared/zod-converter.ts`
- Move: `packages/core/src/hooks-setup.ts` → `packages/core/src/shared/hooks-setup.ts`
- Move: `packages/core/src/plugin-hooks.ts` → `packages/core/src/shared/plugin-hooks.ts`
- Modify: 所有引用方 import 路径

**Step 1: 创建目录**

```bash
New-Item -ItemType Directory -Path "packages/core/src/shared" -Force
```

**Step 2: git mv 文件**

```bash
git mv packages/core/src/tool.ts packages/core/src/shared/tool.ts
git mv packages/core/src/tool-effect.ts packages/core/src/shared/tool-effect.ts
git mv packages/core/src/tool-executor.ts packages/core/src/shared/tool-executor.ts
git mv packages/core/src/message-utils.ts packages/core/src/shared/message-utils.ts
git mv packages/core/src/zod-converter.ts packages/core/src/shared/zod-converter.ts
git mv packages/core/src/hooks-setup.ts packages/core/src/shared/hooks-setup.ts
git mv packages/core/src/plugin-hooks.ts packages/core/src/shared/plugin-hooks.ts
```

**Step 3: 更新 import 路径**

特别注意 `tool.ts` 被几乎所有工具文件引用（`import { make } from "../tool"` → `"../shared/tool"`），这是本 Task 最大工作量。

Run: `Select-String -Pattern "from \"\.\.\/tool\"|from \"\.\/tool\"" -Path "packages/core/src/tools/*.ts"`
→ 所有工具文件的 import 路径需要从 `"../tool"` 改为 `"../shared/tool"`

Run: `Select-String -Pattern "from \"\.\./tool-effect\"|from \"\./tool-effect\"" -Path "packages/core/src/**/*.ts"`

**Step 4: 更新 index.ts**

更新 `index.ts` 中对 shared/ 文件的导出路径。

**Step 5: Typecheck & Test**

```bash
pnpm typecheck
pnpm test
```

**Step 6: Commit**

```bash
git add .
git commit -m "refactor(core): move shared utilities to shared/"
```

---

### Task 4: Phase 1c — 创建 task/ 和 background/ 目录

**Files:**
- Move: `packages/core/src/task-planner.ts` → `packages/core/src/task/planner.ts`
- Move: `packages/core/src/task-tracker.ts` → `packages/core/src/task/tracker.ts`
- Move: `packages/core/src/iteration-budget.ts` → `packages/core/src/task/budget.ts`
- Move: `packages/core/src/background.ts` → `packages/core/src/background/index.ts`
- Move: `packages/core/src/cron-scheduler.ts` → `packages/core/src/background/cron.ts`
- Move: `packages/core/src/worktree-manager.ts` → `packages/core/src/background/worktree.ts`
- Move: `packages/core/src/recovery.ts` → `packages/core/src/background/recovery.ts`

**Step 1-4: 同 Task 2 模式 — git mv → 更新 import → typecheck → commit**

```bash
New-Item -ItemType Directory -Path "packages/core/src/task" -Force
New-Item -ItemType Directory -Path "packages/core/src/background" -Force

git mv packages/core/src/task-planner.ts packages/core/src/task/planner.ts
git mv packages/core/src/task-tracker.ts packages/core/src/task/tracker.ts
git mv packages/core/src/iteration-budget.ts packages/core/src/task/budget.ts
git mv packages/core/src/background.ts packages/core/src/background/index.ts
git mv packages/core/src/cron-scheduler.ts packages/core/src/background/cron.ts
git mv packages/core/src/worktree-manager.ts packages/core/src/background/worktree.ts
git mv packages/core/src/recovery.ts packages/core/src/background/recovery.ts
```

**Step 5: Typecheck & Commit**

```bash
pnpm typecheck
pnpm test
git add .
git commit -m "refactor(core): move task and background modules"
```

---

### Task 5: Phase 2a — 创建 session/ 目录

**Files:**
- Move: `packages/core/src/session-manager.ts` → `packages/core/src/session/manager.ts`
- Move: `packages/core/src/session-store.ts` → `packages/core/src/session/store.ts`
- Move: `packages/core/src/context-manager.ts` → `packages/core/src/session/context.ts`
- Move: `packages/core/src/compaction.ts` → `packages/core/src/session/compaction.ts`
- Move: `packages/core/src/session-fork.ts` → `packages/core/src/session/fork.ts`
- Move: `packages/core/src/snapshot.ts` → `packages/core/src/session/snapshot.ts`

**注意**: session 模块内部互相引用多（session-store 引用 database，context-manager 引用 session-store），建议一次性 mv 全部后统一修 import。

```bash
New-Item -ItemType Directory -Path "packages/core/src/session" -Force
git mv packages/core/src/session-manager.ts packages/core/src/session/manager.ts
git mv packages/core/src/session-store.ts packages/core/src/session/store.ts
git mv packages/core/src/context-manager.ts packages/core/src/session/context.ts
git mv packages/core/src/compaction.ts packages/core/src/session/compaction.ts
git mv packages/core/src/session-fork.ts packages/core/src/session/fork.ts
git mv packages/core/src/snapshot.ts packages/core/src/session/snapshot.ts
```

全局搜索引用后统一修：

Run: `Select-String -Pattern "session-manager|session-store|context-manager|compaction|session-fork|snapshot" -Path "packages/core/src/**/*.ts" -List`
→ 排除 session/ 自身后，记录所有外部引用方（agent.ts, turn-processor, index.ts, dream-distill 等）

Typecheck → Commit.

---

### Task 6: Phase 2b — 创建 config/ 目录

**Files:**
- Move: `packages/core/src/config.ts` → `packages/core/src/config/index.ts`
- Move: `packages/core/src/modes.ts` → `packages/core/src/config/modes.ts`
- Move: `packages/core/src/agent-profile.ts` → `packages/core/src/config/profile.ts`
- Move: `packages/core/src/feature-flags.ts` → `packages/core/src/config/flags.ts`
- Move: `packages/core/src/platform-paths.ts` → `packages/core/src/config/paths.ts`

**注意**: `config.ts` 被 electron 直接引用（`import { loadConfig } from "@mira/core"`），路径更新后需检查 electron 包中的引用。`modes.ts` 被 agent.ts 引用。

```bash
New-Item -ItemType Directory -Path "packages/core/src/config" -Force
git mv packages/core/src/config.ts packages/core/src/config/index.ts
git mv packages/core/src/modes.ts packages/core/src/config/modes.ts
git mv packages/core/src/agent-profile.ts packages/core/src/config/profile.ts
git mv packages/core/src/feature-flags.ts packages/core/src/config/flags.ts
git mv packages/core/src/platform-paths.ts packages/core/src/config/paths.ts
```

Typecheck → Commit.

---

### Task 7: Phase 2c — 创建 orchestrate/ 目录

**Files:**
- Move: `packages/core/src/delegate-runner.ts` → `packages/core/src/orchestrate/delegate.ts`
- Move: `packages/core/src/subagent-manager.ts` → `packages/core/src/orchestrate/subagent.ts`
- Move: `packages/core/src/team-bus.ts` → `packages/core/src/orchestrate/team-bus.ts`
- Move: `packages/core/src/dream-distill.ts` → `packages/core/src/orchestrate/dream.ts`
- Move: `packages/core/src/goal-judge.ts` → `packages/core/src/orchestrate/goal-judge.ts`
- Move: `packages/core/src/goal-manager.ts` → `packages/core/src/orchestrate/goal-manager.ts`
- Move: `packages/core/src/failover.ts` → `packages/core/src/orchestrate/failover.ts`
- Move: `packages/core/src/execution/` → `packages/core/src/orchestrate/execution/`

```bash
New-Item -ItemType Directory -Path "packages/core/src/orchestrate" -Force
git mv packages/core/src/delegate-runner.ts packages/core/src/orchestrate/delegate.ts
git mv packages/core/src/subagent-manager.ts packages/core/src/orchestrate/subagent.ts
git mv packages/core/src/team-bus.ts packages/core/src/orchestrate/team-bus.ts
git mv packages/core/src/dream-distill.ts packages/core/src/orchestrate/dream.ts
git mv packages/core/src/goal-judge.ts packages/core/src/orchestrate/goal-judge.ts
git mv packages/core/src/goal-manager.ts packages/core/src/orchestrate/goal-manager.ts
git mv packages/core/src/failover.ts packages/core/src/orchestrate/failover.ts
git mv packages/core/src/execution/orchestrator.ts packages/core/src/orchestrate/execution.ts
Remove-Item -LiteralPath "packages/core/src/execution" -Recurse
```

Typecheck → Commit.

---

### Task 8: Phase 3 — tools/ 分类

**Files:**
- Create: `packages/core/src/tools/core/`, `knowledge/`, `execution/`, `orchestrate/`, `interaction/`, `infra/`, `shared/`
- Move: 33 个工具文件到对应子目录

**Step 1: 创建子目录**

```bash
New-Item -ItemType Directory -Path "packages/core/src/tools/core" -Force
New-Item -ItemType Directory -Path "packages/core/src/tools/knowledge" -Force
New-Item -ItemType Directory -Path "packages/core/src/tools/execution" -Force
New-Item -ItemType Directory -Path "packages/core/src/tools/orchestrate" -Force
New-Item -ItemType Directory -Path "packages/core/src/tools/interaction" -Force
New-Item -ItemType Directory -Path "packages/core/src/tools/infra" -Force
New-Item -ItemType Directory -Path "packages/core/src/tools/shared" -Force
```

**Step 2: 按分类 git mv 文件**

**core/**（读、写、搜索、git 等基础操作）：
`read-file.ts`, `read-file-effect.ts`, `write-file.ts`, `edit-file.ts`, `list-files.ts`, `grep.ts`, `glob.ts`, `code-search.ts`, `git.ts`, `bash-security.ts`, `search-history.ts`, `create-docx.ts`

**knowledge/**（知识获取）：
`web-search.ts`, `web-browse.ts`, `web-fetch.ts`, `data-analysis.ts`, `memory.ts`

**execution/**（高权限执行）：
`bash.ts`, `code-exec.ts`, `image-gen.ts`

**orchestrate/**（Agent 编排）：
`delegate-task.ts`, `team-tool.ts`, `task-tool.ts`, `cron-tool.ts`, `workflow-tool.ts`, `worktree-tool.ts`, `agent-tools.ts`

**interaction/**（用户交互）：
`question.ts`

**infra/**（基础设施）：
`lsp-tool.ts`

**shared/**（工具公共模块）：
`tool-meta.ts`, `tool-loader.ts`, `tool-output-store.ts`

**Step 3: 更新 tools/index.ts**

当前 `tools/index.ts` 是 22 行导出。改为按子目录导入：

```typescript
// core
export { readFileTool, readFileToolEffect } from "./core/read-file-effect"
export { writeFileTool } from "./core/write-file"
export { listFilesTool } from "./core/list-files"
// ...（保持按文件名导入，只改路径）
```

**Step 4: 更新跨工具引用**

`tool-loader.ts` 引用了 `tool-meta.ts`，`tool-output-store.ts` 可能被其他工具引用。
`bash-security.ts` 被 `bash.ts` 引用。

Run: `Select-String -Pattern "from \"\.\./tools|from \"\.\/" -Path "packages/core/src/tools/**/*.ts"`
→ 查找所有工具文件间的相对引用，更新路径。

**Step 5: Typecheck 每个子目录**

逐个目录搬完后 typecheck，不要一次性搬 33 个文件然后修。

**Step 6: Commit**

```bash
git add .
git commit -m "refactor(core): categorize tools into subdirectories"
```

---

### Task 9: Phase 4a — agent.ts 搬家

**Files:**
- Move: `packages/core/src/agent.ts` → `packages/core/src/agent/agent.ts`
- Modify: 所有引用 `"../agent"` 或 `"./agent"` 的 import

**Step 1: git mv**

```bash
git mv packages/core/src/agent.ts packages/core/src/agent/agent.ts
```

**Step 2: 更新 agent/agent.ts 中的 30 个 import 路径**

agent.ts 的 import 涉及：
- `"./registry"` → `"../system/registry"`
- `"./types"` → `"../types"`
- `"./iteration-budget"` → `"../task/budget"`
- `"./message-utils"` → `"../shared/message-utils"`
- `"./plugin-hooks"` → `"../shared/plugin-hooks"`
- `"./permission"` → `"../system/permission"`
- `"./memory/manager"` → `"../memory/manager"`
- `"./session-store"` → `"../session/store"`
- `"./permission-gate"` → `"../system/permission/gate"`
- `"./tools/memory"` → `"../tools/knowledge/memory"`
- `"./execution/orchestrator"` → `"../orchestrate/execution"`
- `"./agent/state-machine"` → `"./state-machine"`（同目录）
- `"./agent/context"` → `"./context"`
- `"./permission/approval-store"` → `"../system/permission/approval-store"`
- `"./dream-distill"` → `"../orchestrate/dream"`
- `"./context-manager"` → `"../session/context"`
- `"./goal-judge"` → `"../orchestrate/goal-judge"`
- `"./agent/turn"` → `"./turn"`
- `"./agent/max-mode"` → `"./max-mode"`
- `"./agent/turn-processor"` → `"./turn-processor"`
- `"./agent/utils"` → `"./utils"`
- `"./modes"` → `"../config/modes"`

注意这是**最繁琐的步骤**，30 个 import 全部要手改。建议用编辑工具逐个替换。

**Step 3: 更新外部引用**

Run: `Select-String -Pattern "from \"\.\./agent\"|from \"\.\/agent\"" -Path "packages/core/src/**/*.ts"`
→ 所有引用 `"./agent"` 的检查是否需要改为 `"./agent/agent"`

**Step 4: Typecheck**

```bash
pnpm typecheck
```
修复所有错误。

**Step 5: Commit**

```bash
git add .
git commit -m "refactor(core): move agent.ts into agent/ directory"
```

---

### Task 10: Phase 4b — 删除 llm-sdk.ts

**Files:**
- Delete: `packages/core/src/llm-sdk.ts`
- Modify: `packages/core/src/agent/turn-processor.ts` — 引用 llm-sdk 改为 llm/route
- Modify: `packages/core/src/index.ts` — 更新 createLLMClient 导出路径

**Step 1: 确认引用方**

Run: `Select-String -Pattern "llm-sdk" -Path "packages/core/src/**/*.ts"`
Expected:
- `agent.ts`（但已经搬到 agent/agent.ts，在第 9 步中应已改完）
- `turn-processor.ts`
- `index.ts`

**Step 2: 更新 turn-processor.ts**

第 1 行: `import { createLLMClient, type LLMToolSet, type LLMMessage } from "../llm-sdk"`
改为: `import type { LLMMessage } from "../llm/schema"` + `import { createLLMClient } from "../llm/route/client"` + 导入 LLMToolSet 类型的等效

检查 `createLLMClient` 的返回类型签名是否兼容。

**Step 3: 更新 index.ts**

`export { createLLMClient } from "./llm-sdk"` → `export { createLLMClient } from "./llm/route/client"`

**Step 4: 确认 layers.ts 已删除**

确认 layers.ts 中的 `import { createLLMClient } from "./llm-sdk"` 不再存在（layers.ts 已在 Phase 0 删除）。

**Step 5: 删除 llm-sdk.ts**

```bash
Remove-Item -LiteralPath "packages/core/src/llm-sdk.ts"
```

**Step 6: Typecheck**

```bash
pnpm typecheck
```

**Step 7: Commit**

```bash
git add .
git commit -m "refactor(core): remove llm-sdk.ts backward compat layer"
```

---

### Task 11: Phase 5 — 清理 index.ts

**Files:**
- Modify: `packages/core/src/index.ts`

**Step 1: 重构 index.ts**

目标：从 ~98 行压缩到 ~40 行，消除逐行导出模式。

参考结构：
```typescript
// Agent
export { Agent } from "./agent/agent"
export type { AgentConfig } from "./agent/agent"
export type { AgentEvent } from "./types"

// 系统
export { ToolRegistry } from "./system/registry"
export type { ModelFilter } from "./system/registry"
export { make, withPermission, settle } from "./shared/tool"
export type { ToolDef, ToolContext, ToolResult, ToolCall, Content, Settlement } from "./shared/tool"
export { PermissionSet, defaultPermissions, permissionsForMode } from "./system/permission"
export { loadConfig, saveGlobalConfig, resolveRuntimeConfig, getConfigForRenderer } from "./config"
export type { MiraConfig, ResolvedConfig } from "./config"

// Agent 系统
export { type AgentMode, getModeConfig, getAllModes, modeToPermissionSet, loadCustomAgents, registerAgent, registerAgentFromJson, getModeToolAllowlist } from "./config/modes"
export { type AgentProfile, AgentProfileRegistry, getGlobalAgentDir, getProjectAgentDir } from "./config/profile"
export { ContextManager, type ContextConfig, type ContextStats } from "./session/context"
export { GoalJudge, type Goal, type GoalConfig, type GoalEvaluation } from "./orchestrate/goal-judge"

// LLM
export { createLLMClient } from "./llm/route/client"
export type { SDKConfig as ClientConfig } from "./llm/route/client"

// 工具 — 批量导出
export * from "./tools"

// 系统服务
export { lspManager } from "./lsp/manager"
export { cronScheduler } from "./background/cron"
export { TaskPlanner } from "./task/planner"
export { PluginHooks, pluginHooks } from "./shared/plugin-hooks"
export { SubagentManager, type SubagentInfo, type SubagentStatus, type SubagentEvent, type SubagentEventType } from "./orchestrate/subagent"
export { runDelegate, getDelegationStatus } from "./orchestrate/delegate"
export { setupDefaultHooks } from "./shared/hooks-setup"
export { sendMessage, readInbox } from "./orchestrate/team-bus"
export { createWorktree, listWorktrees } from "./background/worktree"
export { createDefaultRegistry } from "./system/registry-init"

// 配置
export { initPlatformPaths, getPlatformPaths } from "./config/paths"
export type { PlatformPaths } from "./config/paths"

// 服务端
export { ServerManager } from "./system/server-manager"
export type { ServerManagerOptions } from "./system/server-manager"
export { createServer, startServer } from "./system/server"
export type { ServerOptions, APIContext } from "./system/server"

// 新模块
export { featureFlags, isFeatureEnabled } from "./config/flags"
export { SnapshotManager } from "./session/snapshot"
export { SessionForkManager } from "./session/fork"
export { ForkCacheManager } from "./agent/fork-cache"
export { SystemContextManager } from "./agent/system-context"
export { TextNgramMonitor } from "./agent/text-ngram"
export { searchTools, getRecommendedTools, shouldLoadTool } from "./tools/shared/tool-loader"
export * as ToolEffect from "./shared/tool-effect"
```

**Step 2: 检查 electron 包中 `import { ... } from "@mira/core"` 是否全部覆盖**

Run: `Select-String -Pattern "from \"@mira/core\"" -Path "packages/electron/src/**/*.ts", "packages/ui/src/**/*.ts"`
→ 确保 index.ts 中导出的所有类型在 electron/ui 中都能找到

**Step 3: Typecheck**

```bash
pnpm typecheck
pnpm test
```

**Step 4: Commit**

```bash
git add .
git commit -m "refactor(core): clean up index.ts exports"
```

---

### Task 12: 最终验证

**Step 1: 确认根目录文件数量**

Run: `Get-ChildItem -LiteralPath "packages/core/src" -Name` | 过滤出 .ts 文件（不含目录）
Expected: ≤ 5 个（index.ts, types.ts, compose-mode.ts, plugin.ts, mcp.ts, workflow.ts 等）

**Step 2: 全量验证**

```bash
pnpm typecheck
pnpm test
pnpm lint
```

**Step 3: 手工验证**

启动 dev：`pnpm dev`
测试基本 Agent 流程：发送一条消息，确认 Agent 能响应。

**Step 4: 最终提交**

```bash
git add .
git commit -m "refactor(core): complete core restructure"
```

---

## 附录：引用地图

以下是被多个文件引用的热点模块，搬家时需特别注意：

| 模块 | 被引用次数 | 引用方 |
|---|---|---|
| `tool.ts` (→ shared/tool.ts) | 30+ | 几乎所有 tool 文件和 agent |
| `registry.ts` (→ system/registry.ts) | 8+ | agent, turn-processor, hooks-setup |
| `logger.ts` (→ system/logger.ts) | 20+ | 几乎所有模块 |
| `modes.ts` (→ config/modes.ts) | 5+ | agent, index, electron |
| `permission.ts` (→ system/permission/) | 5+ | agent, turn-processor, modes |
| `session-store.ts` (→ session/store.ts) | 5+ | agent, turn-processor, dream |
| `config.ts` (→ config/index.ts) | 5+ | electron, index |
| `database.ts` (→ system/database.ts) | 4+ | session-manager, session-store, server |
| `message-utils.ts` (→ shared/message-utils.ts) | 4+ | agent, turn-processor |
