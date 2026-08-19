# Mira 架构文档

## 一、整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                       渲染进程 (React)                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────────┐  │
│  │ TitleBar │  │ Sidebar  │  │ ChatWindow                 │  │
│  │ 状态指示  │  │ 项目/会话  │  │ ┌─────────────────────┐  │  │
│  │          │  │          │  │ │ ToolPalette（工具面板）│  │  │
│  │          │  │          │  │ │ ChatInput             │  │  │
│  │          │  │          │  │ │ MarkdownRenderer       │  │  │
│  │          │  │          │  │ │ ToolCallView           │  │  │
│  │          │  │          │  │ └─────────────────────┘  │  │  │
│  └──────────┘  └──────────┘  └───────────────────────────┘  │
│                           │                                   │
│                  ┌────────┴────────┐                          │
│                  ▼ IPC (contextBridge)                        │
├──────────────────────────────────────────────────────────────┤
│                    主进程 (Node.js)                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ @mira/core — TypeScript Agent Core                      │  │
│  │  agent/           Agent 核心循环 + 状态机 + 回合编排      │  │
│  │  llm/             LLM 分层架构                           │  │
│  │    schema/        消息/事件/错误类型                      │  │
│  │    protocols/     OpenAI/Anthropic/Gemini 等 5 种协议    │  │
│  │    builtin-providers.ts  12 个 Provider 数据定义          │  │
│  │    route/         路由客户端                             │  │
│  │  tools/           48 个工具（默认注册）                   │  │
│  │  memory/          记忆系统（FTS5 + 动态记忆图谱 + 向量）   │  │
│  │  system/          数据库/权限/注册表/日志/服务            │  │
│  │    permission/    声明式权限系统（gate/store/approval）   │  │
│  │  session/         会话/项目管理 + 上下文压缩 + 事件溯源   │  │
│  │  orchestrate/     编排（Goal/Subagent/Dream/Failover）   │  │
│  │    acp/           Agent 通信协议（消息工厂 + 工作状态机） │  │
│  │  graph/           Graph Engineering 图编排引擎           │  │
│  │  config/          配置多层合并 + Agent 模式              │  │
│  │  task/            任务追踪/规划/预算控制                 │  │
│  │  background/      定时调度/错误恢复/Git Worktree         │  │
│  │  skill/           Skill 动态加载/Slash 命令              │  │
│  │  compose-mode.ts  组合模式（7 阶段）                     │  │
│  │  workflow/        Dynamic Workflow 编排                 │  │
│  │  mcp/             MCP 协议支持                          │  │
│  │  plugin/          插件系统                              │  │
│  │  lsp/             LSP 代码智能                          │  │
│  │  voice/           语音模块（VAD/打断管理）               │  │
│  │  shared/          工具工厂/Zod 转换/消息工具/插件钩子    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                           │                                    │
│                  ┌────────┴────────┐                           │
│                  ▼ LLM APIs        ▼ MCP Servers               │
│  ┌──────────────────┐  ┌──────────────────┐                  │
│  │ OpenAI / Claude  │  │ 外部工具服务器    │                  │
│  │ DeepSeek / Ollama│  │                  │                  │
│  │ Groq / Gemini    │  │                  │                  │
│  └──────────────────┘  └──────────────────┘                  │
└──────────────────────────────────────────────────────────────┘
```

## 二、包架构

```
mira/
├── apps/
│   └── desktop/       # @mira/desktop — Electron 应用壳
├── packages/
│   ├── core/          # @mira/core — 核心逻辑（无外部依赖）
│   ├── electron/      # @mira/electron — Electron 主进程
│   └── ui/            # @mira/ui — React 前端组件
├── docs/
├── data/              # 运行时数据 (SQLite)
├── memory/            # 会话记忆 JSON
├── vector-memory/     # 向量记忆存储
├── tasks/             # 任务进度
├── checkpoints/       # 检查点快照
├── logs/              # 运行日志
├── package.json       # 根 package.json (pnpm monorepo)
└── pnpm-workspace.yaml
```

### 包依赖关系

```
@mira/desktop
  ├── @mira/core
  ├── @mira/ui
  └── @mira/electron

@mira/electron
  └── @mira/core

@mira/ui
  └── @mira/core

@mira/core（独立，无外部依赖）
```

## 三、数据流

### 3.1 AI 对话流

```
用户输入 → ChatWindow → useMiraChat hook
    → IPC "agent:startStream" → sidecar-bridge
    → Core HTTP /api/agent/stream (SSE) → Agent.run()
    → LLM.stream() → Provider API
    → AgentEvent (SSE 事件 → agent:event IPC)
    → ChatWindow 逐事件渲染
```

**真实流式执行走 `agent.startStream` → `sidecar-bridge` → Core HTTP SSE**；旧版 Python 和 Agent API 已从 preload 移除。

### 3.2 工具执行流

```
Agent 循环 → tool_call → PermissionSet.evaluate()
    → 允许/拒绝/询问用户
    → ToolOrchestrator.execute()
    → 具体工具 (readFile / bash / webSearch / git...)
    → 结果返回 Agent 继续循环
```

### 3.3 记忆注入流

```
Agent 启动 → MemoryManager.selectMemories()
    → 搜索各层记忆（checkpoint/builtin/fts/file/vector）
    → 注入系统提示词
    → Agent 带着上下文继续工作
```

### 3.4 子 Agent 流

```
主 Agent → delegate_task / spawn_agent → SubagentManager.spawn()
    → 子 Agent 独立运行（最大并行 5，最大嵌套深度 8）
    → SQLite 注册表持久化 + 孤儿恢复
    → TaskGate 任务门控验证（最多 2 次自动重试）
    → 标准化返回协议（**Status** / **Summary**）
    → ReAct 循环（preStop + postStop，各 3 轮）
    → 粘滞检测（5 分钟无活动 = stuck）
    → 完成后结果返回主 Agent
    → 主 Agent 继续工作
```

## 四、Agent Core 核心模块

### 4.1 Agent 主循环 (`agent/agent.ts`)

```
Agent.run()
  ├→ AgentStateMachine 管理生命周期（idle/running/waiting_permission/stopped/done）
  ├→ ContextManager 管理上下文窗口（4 层压缩管线 + Checkpoint）
  ├→ processTurn() 执行单回合
  │   ├→ buildSystemMessage() 组装系统提示
  │   ├→ LLM.stream() 获取模型输出
  │   ├→ 工具调用 → PermissionSet → ToolOrchestrator
  │   └→ 返回 AgentEvent 流
  ├→ GoalJudge 验证任务完成度
  └→ DoomLoop 检测防止死循环
```

### 4.2 LLM 分层架构

```
schema/          → 类型定义（LLMMessage, LLMStreamEvent, LLMError）
    │
protocols/       → 协议适配（将统一类型转换为各 API 格式）
    ├── openai-chat.ts              → OpenAI Chat Completions
    ├── openai-responses.ts         → OpenAI Responses API
    ├── openai-compatible-chat.ts   → OpenAI 兼容协议（DeepSeek/Ollama/Groq 等）
    ├── anthropic-messages.ts       → Anthropic Messages API
    └── gemini.ts                   → Google Gemini
    │
providers/       → Provider 配置注册（管理认证、路由、重试）
    ├── openai          → OpenAI (gpt-4o, gpt-4o-mini...)
    ├── anthropic       → Anthropic (claude-sonnet-4, claude-opus-4...)
    ├── deepseek        → DeepSeek (deepseek-chat, deepseek-reasoner)
    ├── ollama          → Ollama (本地 llama3 等)
    ├── groq            → Groq (llama3-70b, mixtral...)
    ├── fireworks       → Fireworks AI
    ├── together        → Together AI
    ├── cerebras        → Cerebras
    ├── perplexity      → Perplexity
    ├── gemini          → Google Gemini (gemini-2.0-flash...)
    ├── vertex          → Vertex AI (gemini 协议适配)
    └── custom          → 自定义 OpenAI 兼容 API
    │
route/           → 路由客户端（根据 provider 自动选择协议和认证方式）
```

### 4.3 工具系统

```typescript
// 工具定义 — 使用 make() + Zod Schema
export const myTool = make({
  name: "my_tool",
  description: "What this tool does",
  inputSchema: z.object({
    path: z.string().describe("Path to file"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    // 1. 参数已由 Zod 验证
    // 2. 路径操作用 ctx.workspace 做基路径
    // 3. 捕获异常返回 { success: false, error }
    // 4. 成功返回 { success: true, output }
  },
})
```

48 个工具通过 `system/registry.ts` + `system/registry-init.ts` 注册（`createDefaultRegistry`），分为 8 类：

| 分类 | 工具 | 说明 |
|------|------|------|
| **core** | read_file/write_file/edit_file/list_files/grep/glob/code_search/git_status/git_diff/git_log/git_commit/todo_write/apply_patch/search_history/get_current_time/change_directory/invalid | 文件、搜索、Git、批量编辑、目录/时间、兜底 |
| **document** | create_docx/create_xlsx/create_pptx/create_webpage/create_mockup/create_svg | Word/Excel/PPT/HTML/SVG 生成 |
| **knowledge** | web_search/web_browse/web_fetch/data_analysis/create_chart/memory_search/memory_recall | 网络、数据、记忆 |
| **execution** | bash/run_code/image_generate | Shell、代码、图片 |
| **orchestrate** | delegate_task/team_tool/plan_task/cronjob/worktree/workflow_run/spawn_agent/wait_agents/list_subagents | 子 Agent、任务、调度 |
| **infra** | lsp_definition/lsp_references/lsp_hover | 代码智能 |
| **interaction** | question | 用户交互 |
| **skill** | skills_list/skill_view | Skill 系统 |

另有 5 个记忆图谱工具（memory_activate / memory_graph_*）已实现并导出但**未注册进默认注册表**；MCP/Plugin/自定义工具运行时动态注册（`[MCP: ]` / `[Plugin: ]` 前缀）。

- 并行执行声明
- 权限过滤（permission 字段）
- 工具 allowlist（按模式过滤）
- 错误分类（RecoverableError / FatalError）
- 输出截断上限（maxOutputLength）

### 4.4 权限系统 (`system/permission/`)

```typescript
// 声明式权限规则
const rules: PermissionRule[] = [
  { action: "read_file", resource: "*", effect: "allow" },
  { action: "bash", resource: "ls *", effect: "allow" },
  { action: "bash", resource: "*", effect: "ask" },
  { action: "write_file", resource: "*", effect: "ask" },
]
```

- 通配符匹配（`*` 和 `**`）
- 硬拒绝列表（`rm -rf /`, `sudo` 等）
- 运行时审批（用户可选 allow/deny/always）
- 审批存储（记住用户选择，`approval-store.ts`）
- 过期缓存机制

### 4.5 记忆系统

多 Provider 记忆系统 + 动态记忆图谱：

| Provider | 层级 | 存储 | 说明 |
|----------|------|------|------|
| CheckpointProvider | Session | JSON 文件 | 会话检查点、状态恢复 |
| BuiltinMemoryProvider | Session | 内存 | 高频事实追踪 |
| FTSMemoryProvider | Session | SQLite FTS | 全文检索 |
| FileMemoryProvider | Project | .mira/knowledge/ | 项目级持久知识 |
| VectorMemoryProvider | Project | 本地 ONNX | Transformers.js 向量嵌入 |
| DynamicMemoryManager | 全局 | SQLite 记忆图谱 | 节点/边/社区 + 激活传播 + 衰减遗忘 |

MemoryManager 支持：预算注入（按 token 控制检索量）、跨 Provider 去重、批量刷入写缓冲区、记忆提升（session → project）。动态记忆图谱支持中文分词 + 同义词发现 + 嵌入缓存。

### 4.6 上下文管理 (`session/context.ts`)

```
ContextManager
  ├→ 监控上下文 token 用量
  ├→ 4 层压缩管线（L1 Snip → L2 Micro Compact → L3 大结果持久化 → L4 LLM 摘要）
  ├→ 触发 checkpoint（早期，20%/45%/70%）
  ├→ 主动重建（接近上限时）
  ├→ 应急重建（超出上限时）
  ├→ 注入 checkpoint + 项目记忆 + 全局记忆
  └→ Agent 在新窗口中醒来，状态连续
```

## 五、高级特性

### 5.1 Goal Judge (`orchestrate/`)

独立的验证 Agent，判断任务是否真正完成。

```
Agent 尝试终止 → GoalJudge.evaluate()
    → 独立 LLM 调用审查完整对话
    → 满足 → 允许终止
    → 不满足 → 反馈差距，Agent 继续
    → 连续失败 3 次 → 自动终止
```

### 5.2 Max Mode (`agent/max-mode.ts`)

并行采样选优，每轮生成 N 个候选方案。

```
Agent 决策点 → 并行生成 N 个候选（默认 5）
    → 每个候选独立推理 + 工具规划
    → Judge 模型对比选出最优
    → 执行最优方案
```

### 5.3 Compose Mode (`compose-mode.ts`)

代码开发的完整流水线，通过 7 阶段子 Agent 编排完成从需求到合并的全流程：

```
plan → execute → review → test → debug → verify → merge
```

### 5.4 Dynamic Workflow (`workflow/`)

代码级编排，将流程从 prompt 变为代码。

```javascript
// 主 Agent 生成的 workflow 脚本
export const meta = { name: "refactor", description: "重构流程" }

export default async function(args) {
  const result = await agent("分析代码结构")
  const plan = await agent(`基于分析制定重构计划: ${result}`)
  await parallel([
    () => agent("重构模块 A"),
    () => agent("重构模块 B"),
  ])
  await agent("运行测试验证")
}
```

### 5.5 Dream/Distill (`orchestrate/dream.ts`)

- **Dream**：扫描会话轨迹，提取持久知识到项目记忆
- **Distill**：发现重复工作流，打包为可复用 skill/subagent

### 5.6 Failover (`orchestrate/failover.ts`)

Provider 故障自动降级链：当主 Provider 不可用时，按配置顺序自动切换到次选 Provider。

### 5.7 Subagent 管理 (`orchestrate/subagent.ts`)

基于 Actor 模型的子 Agent 系统，支持以下能力：

```
SubagentManager
  ├→ 调度模式: subagent（共享会话）/ peer（独立工作目录）
  ├→ 注册表持久化: SQLite actor_registry 表 + 孤儿恢复
  ├→ 任务门控: TaskGate 验证任务完成度，最多 2 次自动重试
  ├→ 标准化返回协议: **Status** / **Summary** 结构化输出
  ├→ 上下文继承: none（仅 prompt）/ state（checkpoint 摘要）/ full（前缀缓存）
  ├→ ReAct 循环: preStop 3 轮 + postStop 3 轮
  ├→ 粘滞检测: 5 分钟无活动自动标记 stuck
  ├→ 并发控制: 最大并行 5（可配置），嵌套深度 8，总生命周期 100
  ├→ 团队通信总线 (team-bus)
  ├→ 任务追踪 (task-tracker)
  └→ 结果汇总回主 Agent
```

### 5.8 Skill 系统 (`skill/`)

- `skill-loader.ts` — 从目录动态加载 Skill 定义
- `skill-commands.ts` — Slash 命令补全（`/` 触发）
- `skill-tools.ts` — Skill 导出为可调用工具

## 六、IPC 通信层

### 6.1 模块划分

| 模块 | 职责 |
|------|------|
| handlers.ts | 基础处理（窗口控制、文件对话框、通知、API Key 加解密、悬浮球） |
| compose-ipc.ts | 组合模式全流程 |
| config-ipc.ts | 配置读写 |
| dream-ipc.ts | Dream/Distill 操作 |
| goal-ipc.ts | Goal 管理 |
| graph-ipc.ts | Graph 图编排执行（runCodingTask/状态/停止） |
| live2d-ipc.ts | Live2D 桌宠开关 |
| memory-ipc.ts | 记忆操作（代理到 sidecar HTTP） |
| question-ipc.ts | 用户交互 |
| session-ipc.ts | 会话/项目 CRUD |
| sidecar-bridge.ts | Sidecar 进程通信（HTTP 代理层） |
| skill-ipc.ts | Skill 加载 |
| subagent-ipc.ts | 子 Agent 状态 |
| task-ipc.ts | 任务管理 |

### 6.2 Preload 桥接

```typescript
// preload/index.ts
contextBridge.exposeInMainWorld("electronAPI", {
  agent: { startStream, replyPermission, stopStream, onEvent, suggestFollowUps, executeTool, listTools, ... },
  agent.question / agent.task / agent.subagent / agent.goal / agent.dreamDistill / agent.compose,
  ts: { listProjects, createProject, createSession, listSessions, getSessionMessages, searchMessages, restoreSnapshot, writeFile, ... },
  config: { get, save, getProviderCatalog, ... },
  graph: { runCodingTask, getStatus, listRuns, stop },
  encryptApiKey / decryptApiKey / isEncryptionAvailable,
  memory: { search, searchByProject, getGraphData, status },
  live2d: { toggle },
  floatingBall: { toggle, wake, hide, updateConfig, onStateChange, ... },
  platform, notify,
  openFile / openDirectory / saveFile,
  minimizeWindow / maximizeWindow / closeWindow,
})
```

> `memory.searchByProject` / `memory.getGraphData` 已桥接进 preload（经 `memory-ipc.ts` 代理到 sidecar HTTP）；旧版 Python 和 Agent API 已从 preload 移除。

## 七、数据库

SQLite (sql.js WASM)，WAL 模式 + 防抖持久化（`scheduleSave` 500ms）。核心表（完整 SCHEMA 见 `system/database.ts`）：

```sql
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT DEFAULT '',
  title TEXT DEFAULT '',
  workspace TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  cost REAL DEFAULT 0,
  tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
  tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TEXT DEFAULT (datetime('now')),
  tool_call_id TEXT,
  retry_count INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE permissions (
  workspace TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT DEFAULT '*',
  effect TEXT NOT NULL,
  PRIMARY KEY (workspace, action, resource)
);

CREATE TABLE actor_registry ( ... );  -- 子 Agent 注册表
CREATE TABLE goals ( ... );           -- Goal 追踪
CREATE TABLE session_events ( ... );  -- 事件溯源日志
CREATE TABLE event_snapshots ( ... ); -- 事件快照
CREATE TABLE todos ( ... );           -- Todo 任务
-- FTS5 虚拟表: messages_fts
-- 记忆图谱表: memory_nodes / memory_edges / memory_communities / memory_metadata / memory_embeddings
```

## 八、配置系统

多层配置合并（优先级从高到低）：

1. **环境变量** — `{env:VAR_NAME}` 语法引用
2. **项目配置** — `{workspace}/mira.json`
3. **全局配置** — `~/.config/mira/config.json`
4. **默认值** — 代码内置

支持配置项：
- `provider` / `model` — LLM 选择
- `apiKey` / `apiUrl` — 认证
- `providers` — 多 Provider 配置
- `maxSteps` / `maxContextTokens` — Agent 限制
- `mode` — 默认 Agent 模式
- `mcpServers` — MCP 服务器配置
- `plugins` — 插件配置
- `customAgents` — 自定义 Agent 配置目录

## 九、开发工作流

```bash
# 开发启动
pnpm dev
# → Vite HMR → Electron → Agent Core

# 添加新工具
# 1. 在 packages/core/src/tools/ 创建 .ts 文件
# 2. 使用 make() + Zod Schema
# 3. 在 tools/index.ts 导出
# 4. 在 system/registry-init.ts 注册

# 添加新 Provider
# 1. 在 packages/core/src/llm/builtin-providers.ts 添加数据定义
# 2. 如需新协议，在 llm/protocols/ 创建协议适配并注册到 provider-catalog.ts

# 添加新模式
# 1. 在 config/profile.ts 的 createDefaultRegistry() 中注册
# 2. 或在 ~/.config/mira/agents/ 创建 JSON 配置文件

# 测试
pnpm test          # 运行测试
pnpm typecheck     # 类型检查
pnpm lint          # 代码检查

# 打包
pnpm package:win   # Windows 便携模式
pnpm package:mac   # macOS
pnpm package:linux # Linux
```

## 十、关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 技术栈 | 全 TypeScript | 零 Python 依赖，单一技术栈 |
| 数据库 | SQLite (sql.js WASM) | 零配置，适合桌面应用 |
| 通信方式 | IPC (contextBridge) + Sidecar HTTP | IPC 为主流程，Sidecar 为可选代理层 |
| 前端 UI | @assistant-ui/react | 现代化 AI 聊天组件 |
| 状态管理 | React hooks | 轻量级，桌面应用足够 |
| LLM 架构 | 分层（schema→protocols→providers→route） | 可扩展，新协议/Provider 无侵入 |
| 权限 | 声明式规则 + 硬拒绝 + 运行时审批 | 灵活且安全 |
| 记忆 | 五层 + 预算注入 + 去重 | 可审查、可扩展、不阻塞主 Agent |
| 打包 | 便携模式（electron-builder） | 目标电脑无需安装任何运行时 |

## 十一、KV Cache 纪律（提升缓存命中率）

LLM 对话中的"输入（命中缓存）"指服务端复用的前缀 token，价格仅 1/10。要保持高命中率，系统提示和工具 schema 的前缀必须跨 turn 稳定。

### 前缀结构（按 priority 排序）

```
base(10) → env(20) → mode(30) → knowledge(45) → code(50) → goal(60) → memory(100)
```

- **稳定段**（base/env/mode/knowledge/code/goal）：跨 turn 不变，是缓存命中的核心
- **易变段**（memory，priority 100 末尾）：每 turn 可能变化，隔离到尾部避免破坏稳定前缀

### 纪律规则

1. **新增 Source 时声明缓存影响**：在 `ContextSource` 实现中注释说明其对前缀稳定性的影响（仿 dsh `adding-a-package.md:96`）
2. **稳定内容放前、易变内容放末尾**：系统提示的 `priority` 越低越靠前，优先级越低越稳定
3. **不注入可变时间戳到稳定段**：日期、时间戳等放系统提示末尾（`EnvSource` priority 20，`MemorySource` priority 100）
4. **工具 schema 注册顺序稳定**：`ToolRegistry` 注册顺序决定工具列表顺序，顺序变化会破坏前缀
5. **Anthropic 缓存断点收敛为三锚点**：系统提示断点 + 最后一个 tool 断点 + 最新 user 消息断点（对齐 opencode 策略）

### Anthropic cache_control 策略

- system：每个 system block 打断点（`cache-policy.ts withSystemCache`）
- tools：只给最后一个 tool 打断点（`cache-policy.ts withToolsCache`）
- messages：只给最后一条 user 消息打断点（`cache-policy.ts withMessageCache`）
- DeepSeek/OpenAI：服务端自动缓存，无需注入断点

### 添加新 Source 的检查清单

| 检查项 | 说明 |
|--------|------|
| priority 位置 | 易变内容优先级 > 60（末尾），稳定内容 < 50（前段） |
| fingerprint 稳定性 | 同一内容生成相同 hash，避免随机/时间依赖 |
| loadSnapshot | 若 Source 无 loadSnapshot，每次 build 重新 generate（性能 OK，不影响缓存） |
| KV Cache 声明 | 在 Source 实现中注释说明其对缓存前缀的影响 |

## 十二、依赖纪律（verify:deps）

用 `scripts/verify-deps.ts` 强制依赖方向（`pnpm verify:deps`），规则：

| 规则 | 内容 |
|------|------|
| 1. 跨包钻取 | `packages/electron`、`packages/ui` 禁止 import `@mira/core/<子路径>`，只允许 `@mira/core` 顶层导出（core 内部文件移动不破坏外部） |
| 2. 反向依赖 | `packages/core/src/system/` 下**非 API 层**（非 `server/`）禁止反向依赖底层模块（agent/session/tools/graph/memory/orchestrate/task/skill）；**API 层（`system/server/`）豁免**——聚合底层服务是 handler 分发的合理分层 |
| 3. 三级深路径 | `../..` 深路径仅报告（不阻塞），提示模块边界可优化 |

**设计说明**：`system/server/api.ts` 是 API 聚合层（714 行、25+ 依赖），依赖底层是合理分层而非耦合问题；其体积问题属"拆分 handler"范畴（api-agent/api-session/...），留待后续演进。

## 十三、能力缝（Capability Seams）

`packages/core/src/capability/` 实现 Service Definition / Provider / Consumer 三角色（对齐 dsh capability-seams）：

| 缝 | Provider | 消费端 | 说明 |
|----|---------|--------|------|
| `fs` | `LocalFileSystemProvider` | read_file / write_file | 文件 IO |
| `subprocess` | `LocalSubprocessProvider` | bash 执行 | 命令执行（含 sandbox 包封） |
| `code-runtime` | `LocalCodeRuntimeProvider` | run_code | Python/Node 沙箱执行 |
| `shell` | `LocalShellProvider` | bash shell 解析 | 平台探测 + 参数构建 |
| `sandbox` | `NoopSandboxProvider` | subprocess 包封 | 进程限制（默认透传） |

**注册可逆**：`capabilityRegistry.register(name, provider)` 返回卸载函数。换任意 provider（如远程沙箱）即让对应工具链整体迁移，消费端零改动。
