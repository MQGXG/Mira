# Mira 双模平台（桌面 + 终端编码代理）实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标：** 将现有 Mira 从"纯桌面应用"改造为"一套引擎，两套界面"的双模平台——保持桌面助手的同时，产出终端编码代理

**架构决策：** Monorepo + 分层抽象
```
packages/core   → 纯 TS 引擎（无 Electron 依赖）
packages/desktop → 现有 Electron 桌面应用（依赖 core）
packages/cli    → 新增终端编码代理（依赖 core）
```

**前置条件：** 先完成 `docs/plans/2026-06-16-mira-agent-core-optimization.md` 的全部 P0/P1 任务（安全修复 + 稳定性）

---

## 总体路线图

```
Phase 0（1周）: P0/P1 优化修复 ← 必须先完成
Phase 1（1周）: Monorepo + Core 提取
Phase 2（1周）: CLI/TUI 终端编码代理
Phase 3（持续）: 差异化竞争策略
```

---

## Phase 0：优化修复（Week 1）

执行 `docs/plans/2026-06-16-mira-agent-core-optimization.md` 中的：
- **P0 全部（Task 1-4）**：Bash 误报、子代理权限、SQL 安全、持久化审批
- **P1 全部（Task 5-7）**：LLM 重试、Memory 日志、Handler 清理
- **P2（Task 9-11）**：工具元数据、日志迁移、截断保护

验证标准：
- `npm run typecheck` 通过
- `npm test` 通过
- 手动测试 Agent 循环完整跑通

---

## Phase 1：Monorepo + Core 提取（Week 2）

### Task 1：搭建 Monorepo 骨架

**文件：** 根目录结构改造

```
mira/
├── package.json              ← workspaces: ["packages/*"]
├── turbo.json                ← Turborepo 配置
├── bun.lock / package-lock
├── packages/
│   ├── core/                 ← 纯 TS Agent 引擎（新建）
│   ├── desktop/              ← 现有项目迁移（修改）
│   └── cli/                  ← 终端编码代理（新建）
├── docs/
├── electron/                 ← 删除：内容迁移到 packages/desktop
├── src/                      ← 删除：内容迁移到 packages/desktop/src
└── agent-backend/            ← 保留：Python 后端
```

**Step 1：根 package.json 改为 workspace**

```json
{
  "name": "mira-monorepo",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "dev": "npm run dev -w packages/desktop",
    "dev:cli": "npm run dev -w packages/cli",
    "build": "npm run build -w packages/core && npm run build -w packages/desktop",
    "typecheck": "npm run typecheck -w packages/core && npm run typecheck -w packages/desktop",
    "test": "npm run test -w packages/core"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.0"
  }
}
```

**Step 2：turbo.json**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {},
    "dev": {
      "cache": false
    }
  }
}
```

**Step 3：提交**

```bash
git add package.json turbo.json
git commit -m "build: 搭建monorepo workspace结构"
```

---

### Task 2：提取 packages/core（关键任务）

**核心原则：** `packages/core` 必须是纯 TypeScript，绝对不能有 `import from "electron"`。

**Step 1：分析 Electron 依赖分布**

| 文件 | 依赖 | 抽象方案 |
|------|------|---------|
| `config.ts:4` | `import { app } from "electron"` | 注入 `PlatformPaths` 接口 |
| `database.ts:2,11` | `app.getPath("userData")` | 同上 |
| `session-manager.ts:3,28` | `app.getPath("userData")` | 同上 |
| `fts-memory-provider.ts:65` | `app.getPath("userData")` | 同上 |
| `ipc-bridge.ts` | `ipcMain`, `BrowserWindow` | **留在 desktop 包**，不进入 core |
| `main.ts` | Electron | 留在 desktop |

**Step 2：创建 PlatformPaths 接口**

新建 `packages/core/src/platform.ts`：
```typescript
/**
 * 平台路径接口 — 适配器模式
 * desktop 包传入 Electron 实现
 * cli 包传入 Node.js 实现
 */
export interface PlatformPaths {
  getUserDataPath(): string
  getConfigPath(): string
  getDBPath(): string
  getProjectsPath(): string
}

/** 开发/测试用默认实现 */
export function createDefaultPlatformPaths(basePath: string): PlatformPaths {
  return {
    getUserDataPath: () => basePath,
    getConfigPath: () => `${basePath}/config.json`,
    getDBPath: () => `${basePath}/mira.db`,
    getProjectsPath: () => `${basePath}/projects.json`,
  }
}
```

**Step 3：修改 core 代码使用 PlatformPaths**

在 `packages/core/src/config.ts` 中：
```typescript
// 删除：import { app } from "electron"
import type { PlatformPaths } from "./platform"
// 函数签名改为接受 PlatformPaths
export function getGlobalConfigPath(paths: PlatformPaths): string {
  return paths.getConfigPath()
}
```

在 `packages/core/src/session-manager.ts` 中：
```typescript
// 删除：import { app } from "electron"
// 构造函数接受 PlatformPaths
```

在 `packages/core/src/database.ts` 中：
```typescript
// 接受 PlatformPaths 而非 app
export async function initDatabase(paths: PlatformPaths): Promise<SqliteDb>
```

**Step 4：创建 packages/core 的 package.json**

```json
{
  "name": "@mira/core",
  "version": "1.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "effect": "^3.21.3",
    "zod": "^4.4.3",
    "sql.js": "^1.14.1"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^4.1.8"
  }
}
```

**Step 5：复制代码到 packages/core/src/**

以下文件可以直接复制（纯 TS，零修改）：
```
agent.ts           ← 已检查：纯 TS
tool.ts            ← 已检查：纯 TS
tool-effect.ts     ← 已检查：纯 TS
registry.ts        ← 已检查：纯 TS
registry-init.ts   ← 已检查：纯 TS
types.ts           ← 已检查：纯 TS
modes.ts           ← 已检查：纯 TS
permission.ts      ← 已检查：纯 TS
permission-gate.ts ← 已检查：纯 TS
permisssion/       ← 已检查：纯 TS
memory/types.ts    ← 已检查：纯 TS
memory/manager.ts  ← 已检查：纯 TS
memory/builtin-provider.ts  ← 已检查
memory/file-memory-provider.ts  ← 已检查
memory/vector-provider.ts   ← 已检查
tools/*.ts         ← 全部纯 TS
tool-executor.ts   ← 已检查
execution/*.ts     ← 已检查
message-utils.ts   ← 已检查
delegate-runner.ts ← 已检查
layers.ts          ← 已检查：纯 TS
iteration-budget.ts ← 已检查
llm-sdk.ts         ← 已检查
llm/               ← 已检查
lsp/               ← 已检查
logger.ts          ← 检查
plugin-hooks.ts    ← 检查
cron-scheduler.ts  ← 检查
task-planner.ts    ← 检查
team-bus.ts        ← 检查
worktree-manager.ts ← 检查
skill/             ← 检查
```

以下文件需要注入 PlatformPaths：（后面几步完成）
```
config.ts          ← 需要改
database.ts        ← 需要改
session-manager.ts ← 需要改
session-store.ts   ← 需要改
fts-memory-provider.ts  ← 需要改
```

**Step 6：tsconfig.json for core**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

**Step 7：提交**

```bash
git add packages/core/
git add turbo.json
git commit -m "feat: 提取packages/core纯TS引擎"
```

---

### Task 3：改造 packages/desktop 依赖 core

**Step 1：desktop 的 package.json**

```json
{
  "name": "@mira/desktop",
  "version": "1.0.0",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "package": "electron-vite build && electron-builder"
  },
  "dependencies": {
    "@mira/core": "*",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "lucide-react": "^0.400.0"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-vite": "^2.3.0",
    "electron-builder": "^24.13.3",
    "typescript": "^5.5.0",
    "@vitejs/plugin-react": "^4.3.1",
    "tailwindcss": "^3.4.4"
  }
}
```

**Step 2：创建 ElectronPlatformPaths**

```typescript
// packages/desktop/src/electron-platform.ts
import { app } from "electron"
import { join } from "path"
import type { PlatformPaths } from "@mira/core"

export const electronPlatformPaths: PlatformPaths = {
  getUserDataPath: () => app.getPath("userData"),
  getConfigPath: () => join(app.getPath("userData"), "config.json"),
  getDBPath: () => join(app.getPath("userData"), "mira.db"),
  getProjectsPath: () => join(app.getPath("userData"), "projects.json"),
}
```

**Step 3：修改 main.ts 注入 PlatformPaths**

```typescript
import { initDatabase } from "@mira/core"
import { electronPlatformPaths } from "./electron-platform"

async function initializeApp() {
  await initDatabase(electronPlatformPaths)
  // ...
}
```

**Step 4：移动 electron/ 内容到 packages/desktop/**

```bash
mv electron/ packages/desktop/electron/
mv src/ packages/desktop/src/
mv electron-builder.yml packages/desktop/
mv electron.vite.config.ts packages/desktop/
mv tailwind.config.js packages/desktop/
mv postcss.config.js packages/desktop/
```

**Step 5：提交**

```bash
git add packages/desktop/
git rm -r electron/ src/
git commit -m "refactor: desktop包迁移至packages/desktop并依赖core"
```

---

### Task 4：Agent IPC 从 core 分离（留在 desktop）

**问题：** `ipc-bridge.ts` 依赖 `ipcMain`/`BrowserWindow`，不能进 core。

**Step 1：创建注册函数 API**

在 `packages/core/src/agent.ts` 中，`Agent` 类已经是纯 TS。`ipc-bridge.ts` 只是"把 Agent 暴露成 Electron IPC"的适配层。

保留 `ipc-bridge.ts` 在 `packages/desktop/` 中，改为：
```typescript
// packages/desktop/src/ipc-bridge.ts
import { Agent, ToolRegistry, createDefaultRegistry } from "@mira/core"
import { electronPlatformPaths } from "./electron-platform"
```

**Step 2：提交**

```bash
git add packages/desktop/src/ipc-bridge.ts
git commit -m "refactor: IPC桥接层保留在desktop包"
```

---

### Task 5：core 包端到端验证

**Step 1：写一个最小验证脚本**

```typescript
// packages/core/test/smoke.ts
import { Agent, ToolRegistry, createDefaultRegistry, createLLMClient } from "../src"
import { createDefaultPlatformPaths } from "../src/platform"

async function main() {
  const paths = createDefaultPlatformPaths("/tmp/mira-test")
  const registry = createDefaultRegistry()
  const agent = new Agent(registry, "sk-test", "https://api.openai.com/v1", "/tmp/test-workspace")
  
  const events: any[] = []
  for await (const evt of agent.run("Hello", [], {
    sessionID: "test-1",
    workspace: "/tmp/test-workspace",
    model: "gpt-4o",
    apiKey: "sk-test",
    apiUrl: "https://api.openai.com/v1",
    provider: "openai",
  })) {
    events.push(evt)
  }
  console.log(`Agent ran: ${events.length} events`)
}

main().catch(console.error)
```

**Step 2：类型检查**

```bash
cd packages/core && npx tsc --noEmit
```

**Step 3：提交**

```bash
git add packages/core/test/
git commit -m "test: core包端到端冒烟测试"
```

---

## Phase 2：CLI/TUI 终端编码代理（Week 3）

### Task 6：CLI 入口

**新建 `packages/cli/`**

**Step 1：cli 的 package.json**

```json
{
  "name": "@mira/cli",
  "version": "1.0.0",
  "bin": {
    "mira": "./bin/mira.js"
  },
  "scripts": {
    "dev": "tsx watch bin/mira.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@mira/core": "*",
    "ink": "^4.0.0",
    "react": "^18.3.0",
    "meow": "^12.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.0.0"
  }
}
```

**Step 2：创建 Node.js PlatformPaths**

```typescript
// packages/cli/src/node-platform.ts
import { join } from "path"
import { homedir } from "os"
import { mkdirSync } from "fs"
import type { PlatformPaths } from "@mira/core"

const MIRA_HOME = join(homedir(), ".mira")

export function ensureMiraDir(): void {
  mkdirSync(MIRA_HOME, { recursive: true })
}

export const nodePlatformPaths: PlatformPaths = {
  getUserDataPath: () => MIRA_HOME,
  getConfigPath: () => join(MIRA_HOME, "config.json"),
  getDBPath: () => join(MIRA_HOME, "mira.db"),
  getProjectsPath: () => join(MIRA_HOME, "projects.json"),
}
```

**Step 3：CLI 主入口**

```typescript
// packages/cli/bin/mira.ts
#!/usr/bin/env node
import meow from "meow"
import { startRepl } from "../src/repl"

const cli = meow({
  help: `
    Usage: mira [command] [options]
    
    Commands:
      mira              启动交互式 REPL
      mira "问个问题"    单轮对话
      mira --mode plan  指定 Agent 模式
      mira --help       查看帮助
      
    Options:
      --provider, -p    LLM Provider (默认: openai)
      --model, -m       模型名 (默认: gpt-4o)
      --mode, -M        Agent 模式 (assistant/plan/action/safe)
      --workspace, -w   工作区目录
      --version, -v     显示版本
  `,
  flags: {
    provider:  { type: "string", alias: "p", default: "openai" },
    model:     { type: "string", alias: "m", default: "gpt-4o" },
    mode:      { type: "string", alias: "M", default: "assistant" },
    workspace: { type: "string", alias: "w", default: process.cwd() },
  },
  importMeta: import.meta,
})

if (cli.input.length > 0) {
  // 单轮模式
  await runSingleTurn(cli.input.join(" "), cli.flags)
} else {
  // REPL 模式（使用 Ink TUI）
  await startRepl(cli.flags)
}
```

**Step 4：REPL 模式（无 UI 的简单 Readline）**

```typescript
// packages/cli/src/repl.ts
import * as readline from "readline"
import { Agent, createDefaultRegistry, loadConfig, resolveRuntimeConfig } from "@mira/core"
import { nodePlatformPaths, ensureMiraDir } from "./node-platform"

export async function startRepl(flags: Record<string, any>): Promise<void> {
  ensureMiraDir()
  
  const config = resolveRuntimeConfig(flags, nodePlatformPaths)
  const registry = createDefaultRegistry()
  const agent = new Agent(registry, config.apiKey, config.apiUrl, flags.workspace)
  
  console.log(`\n  Mira CLI v1.0.0 — ${config.mode} 模式`)
  console.log(`  模型: ${config.provider}/${config.model}`)
  console.log(`  工作区: ${flags.workspace}\n`)
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "mira> ",
  })
  
  rl.prompt()
  
  for await (const line of rl) {
    const msg = line.trim()
    if (msg === "/exit") break
    if (msg === "/help") { showHelp(); rl.prompt(); continue }
    
    for await (const evt of agent.run(msg, [], {
      sessionID: `cli-${Date.now()}`,
      workspace: flags.workspace,
      ...config,
    })) {
      switch (evt.type) {
        case "content":
          process.stdout.write(evt.text)
          break
        case "tool_start":
          console.log(`\n\x1b[90m  → 使用工具: ${evt.name}\x1b[0m`)
          break
        case "tool_result":
          console.log(`\x1b[90m  ← 工具结果: ${evt.result.success ? "✓" : "✗"}\x1b[0m`)
          break
        case "error":
          console.error(`\x1b[31m错误: ${evt.message}\x1b[0m`)
          break
        case "finish":
          console.log("\n")
          break
      }
    }
    rl.prompt()
  }
  
  rl.close()
}
```

**Step 5：提交**

```bash
git add packages/cli/
git commit -m "feat: CLI入口+REPL模式，支持单轮对话和交互式会话"
```

---

### Task 7：Ink TUI（终端 UI）

**可选增强：** 用 React Ink 实现更美观的终端交互界面。

```typescript
// packages/cli/src/tui/app.tsx
import React, { useState, useEffect } from "react"
import { render, Box, Text, useInput, useApp } from "ink"
import { Agent, createDefaultRegistry } from "@mira/core"

function MiraTUI() {
  const [messages, setMessages] = useState<any[]>([])
  const [input, setInput] = useState("")
  
  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="single" paddingX={1}>
        <Text bold color="cyan">Mira</Text>
        <Text dimColor> — 终端编码代理</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" padding={1}>
        {messages.map((m, i) => (
          <Text key={i}>{m}</Text>
        ))}
      </Box>
      <Box borderStyle="single" paddingX={1}>
        <Text>&gt; {input}</Text>
      </Box>
    </Box>
  )
}

render(<MiraTUI />)
```

**提交：**
```bash
git add packages/cli/src/tui/
git commit -m "feat: Ink TUI终端界面"
```

---

### Task 8：CLI 全局安装支持

**Step 1：添加 npm bin**

在 `packages/cli/package.json` 已有 `"bin": { "mira": "./bin/mira.js" }`。

**Step 2：编译后自动链接**

```bash
# 在 monorepo 根目录
npm run build -w packages/core && npm run build -w packages/cli
npm link  # 或 npm install -g .
```

**Step 3：验证**

```bash
mira --help
mira --mode plan "分析这个项目的结构"
```

**Step 4：提交**

```bash
git add packages/cli/package.json
git commit -m "feat: CLI全局安装支持(mira命令)"
```

---

## Phase 3：差异化竞争策略（长期）

### Strategy 1：GUI + CLI 双模（已完成）

**核心差异点：** 其他三家只有 CLI/TUI，Mira 有 Electron 桌面 GUI。

**持续优化：**
- 桌面端和 CLI 共享同一个 Agent 会话（通过 SQLite 同步）
- 桌面端可以做可视化调试（工具调用 DAG 图、Token 用量图表）
- CLI 的配置与桌面端一致（共享 `~/.mira/config.json`）

### Strategy 2：Python 后端生态（中期）

**其他三家都没有 Python 后端。** Mira 独有的生态：

```
用户需求："帮我做个数据分析"
  └→ Agent 调用 data_analysis 工具
    └→ Python 子进程执行 Pandas 脚本
      └→ 结果以表格/图表返回给用户
```

**实施路径：**
1. 用 `portable-python/` 做嵌入式 Python 环境
2. `agent-backend/app/tools/` 实现 Python 数据科工具
3. 支持从 CLI 和桌面端统一调用

### Strategy 3：LSP 深度集成（已有雏形）

**其他三家都没有。** 我们有 `lsp_definition/references/hover`，可以扩展：
- `lsp_code_action` → 自动修复
- `lsp_completion` → 内联补全
- `lsp_rename` → 全局重命名

### Strategy 4：多模态（桌面端独占）

CLI 无法做到的能力：
- **图片生成** → `image_gen` 工具已有，桌面直接显示
- **浏览器自动化** → `web_browse` 工具 + 截图
- **代码可视化** → 依赖图、调用链图

### Strategy 5：IDE 插件（远期）

参考 Codex 的 VS Code/Cursor 插件策略：
- Mira 引擎作为本地 LSP 服务器
- VS Code 扩展接入
- 和 CLI/桌面端共享同一个会话记忆

---

## 执行时间线总览

```
Week 1 ─ Phase 0 优化修复
  ├─ P0 安全修复 (Bash/子代理/SQL/持久化)
  ├─ P1 稳定性 (LLM重试/Memory日志/Handler清理)
  └─ P2 补缺 (元数据/日志/截断)

Week 2 ─ Phase 1 Monorepo + Core 提取
  ├─ 骨架：turbo.json + workspace
  ├─ core：复制+抽象PlatformPaths
  ├─ desktop：瘦身+依赖core
  └─ 验证：端到端冒烟测试

Week 3 ─ Phase 2 CLI/TUI 终端编码代理
  ├─ CLI入口+REPL模式
  ├─ Ink TUI（可选增强）
  └─ 全局安装+发布准备

Week 4+ ─ Phase 3 差异化
  ├─ Python后端集成
  ├─ LSP深度扩展
  ├─ IDE插件
  └─ 多模态增强
```

**总工作量：~3 周全功能，~1 周可出最小可用版**

最小可用版（1 周目标）：完成 Phase 0 + Phase 1 → 有一个能跑 `mira "写一个排序算法"` 的 CLI，用 readline REPL 而非 Ink TUI。
