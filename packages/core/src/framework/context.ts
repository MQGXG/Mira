/**
 * Mira Context 扩展 — 声明 Mira 服务注册表（对齐 dsh Capability Seams）
 *
 * 通过 TypeScript declare module 声明合并，把 Mira 的核心服务挂到 Cordis
 * Context 上：ctx.tools / ctx.llm / ctx.permissions / ctx.sessions 等。
 * 插件通过 ctx.<服务名> 寻址服务，而非 import 具体实现（单一寻址空间）。
 */

import type { LLMClient } from "../llm/client"
import type { LLMTurnConfig } from "../agent/turn"
import type { ToolDef, ToolContext, ToolResult } from "../shared/tool"
import type { PermissionRule } from "../system/permission"
import type { PermissionSet } from "../system/permission"
import type { SessionInfo } from "../session/manager"
import type { StoredSession } from "../session/store"
import type { MemoryNode } from "../memory/memory-node"
import type { MCPServerConfig } from "../mcp/index"
import type { ProviderDef, ModelDef } from "../llm/provider-catalog"
import type { AgentMode } from "../config/modes"
import type { AgentConfig } from "../agent/constants"
import type { Agent } from "../agent/agent"
import type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
} from "../services/agents"
import type { WorkflowDefinition, WorkflowRunOptions, WorkflowResult } from "../workflow/index"
import type { CodingState, CodingTaskOptions } from "../graph/templates/coding-task"
import type { SubagentInfo, SubagentEvent } from "../orchestrate/subagent"
import type { Goal, GoalConfig, GoalEvaluation } from "../orchestrate/goal-judge"
import type { DreamResult, KnowledgeEntry, GraphStore } from "../orchestrate/dream-types"
import type { ComposePhase, ComposeState, ComposeSkill } from "../compose-mode"
import type { BackgroundStatus, BackgroundTask } from "../background/index"
import type { Task, TaskStatus } from "../task/tracker"
import type { VoiceEngineDef, VoiceEngineKind } from "../voice/types"
import type { LSPServerManager } from "../lsp/manager"

declare module "../vendor/cordis/context" {
  interface Context {
    // ── 核心服务 ──────────────────────────────────────
    /** LLM 客户端工厂 + Provider 目录 */
    llm?: LLMService
    /** 工具注册表（注册/物化/执行） */
    tools?: ToolService
    /** 权限引擎（allow/deny/ask 三层 Gate） */
    permissions?: PermissionService
    /** 会话管理 */
    sessions?: SessionService
    /** 记忆服务（6 层 Provider 统一调度） */
    memory?: MemoryService
    /** 动态记忆图谱（衰减 + 激活传播） */
    dynamicMemory?: DynamicMemoryService

    // ── 扩展服务 ──────────────────────────────────────
    /** MCP 连接管理 */
    mcp?: MCPService
    /** Provider 目录（模型/能力数据） */
    catalog?: CatalogService
    /** 全局配置（工作区/模式/特性开关） */
    config?: ConfigService
    /** Agent 循环（AgentFactory 实现：createAgent/resume，可替换循环） */
    agentLoop?: AgentLoopService
    /** Agent 实时注册表（register/enter/announce + 工厂委托） */
    agents?: AgentRegistryService
    /** 系统提示装配（variable/section/tools 面包装 SourceManager） */
    systemPrompt?: SystemPromptService
    /** 当前 agent（Agent 作用域 ctx 上以 own property 覆盖，DX accessor） */
    agent?: Agent

    // ── 特色功能服务（引擎持有 + 可替换，插件经 ctx 寻址） ──
    /** Dynamic Workflow 编排引擎 */
    workflow?: WorkflowService
    /** Graph 图编排引擎（coding-task 模板运行 + 运行状态） */
    graph?: GraphService
    /** 组合模式（phase 驱动工作流） */
    compose?: ComposeService
    /** 子 Agent 管理（Actor 模型） */
    subagent?: SubagentService
    /** Goal 完成度验证（GoalJudge） */
    goal?: GoalService
    /** Dream/Distill 记忆进化 */
    dream?: DreamService
    /** LSP 代码智能（Language Server 生命周期 + 查询） */
    lsp?: LSPService
    /** Skill 系统（扫描/加载，目录可配置） */
    skill?: SkillService
    /** 后台任务队列 + 定时调度 + 完成通知 */
    background?: BackgroundService
    /** 任务追踪 + 规划（TaskTracker/TaskPlanner 单一寻址） */
    task?: TaskService
    /** 语音引擎目录 + 引擎工厂（VoiceRegistry 服务视图） */
    voice?: VoiceService

    // ── Capability Seams（Definition 持 Provider，可替换） ──
    /** 文件系统缝：ctx.fs.setProvider(remoteFs) 换整个产品 */
    fs?: import("../services/capability").MiraFileSystemService
    /** 子进程缝：ctx.subprocess.setProvider(...) */
    subprocess?: import("../services/capability").MiraSubprocessService
    /** Shell 缝：ctx.shell.setProvider(...) */
    shell?: import("../services/capability").MiraShellService
  }
}

// ── Agent 实时注册表（对齐 dsh AgentRegistry，实现于 services/agents.ts） ──
export interface AgentRegistryService {
  register(agent: Agent): () => void
  enter(agent: Agent, owner: Agent | undefined): () => void
  announce(agent: Agent): void
  get(id: string): Agent | undefined
  list(): Agent[]
  roots(): Agent[]
  isOwnedBy(id: string, owner: Agent): boolean
  setFactory(factory: AgentFactory): () => void
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  currentInitiator(): Agent | undefined
  requireInitiator(): Agent
  withInitiator<T>(agent: Agent, operation: () => T): T
  withoutInitiator<T>(operation: () => T): T
}

export type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions, AgentSetup, AgentSetupCommit } from "../services/agents"

// ── 服务接口（插件可注入依赖的稳定契约）──────────────────

/** 系统提示服务：variable/section/tools 面包装 SourceManager（实现于 services/system-prompt.ts） */
export interface SystemPromptService {
  section(section: { name: string; order: number; text: (context: unknown) => string }): () => void
  context(contribution: { name: string; order: number; text: (context: unknown) => string }): () => void
  suppressRuntimeContext(): () => void
  tools(provider: (context: unknown) => string): () => void
  variable(name: string, provider: (context: unknown) => string | undefined): () => void
  assemble(context?: unknown): Promise<{ system: string; context: string }>
}

/** LLM 服务：客户端工厂 + 模型目录 */
export interface LLMService {
  createClient(config: LLMTurnConfig): LLMClient
  listModels(providerId?: string): ModelDef[]
}

/** 工具服务：注册 / 限制 / 守卫 / 物化 / 执行 */
export interface ToolService {
  /** 注册工具（对齐 dsh：返回精确 disposer；作用域 ctx 下写入作用域层） */
  register(tool: ToolDef): () => void
  /** 可逆注册（对齐 dsh 形态的命名兼容） */
  registerEffectively(tool: ToolDef): () => void
  unregister(name: string): boolean
  get(name: string): ToolDef | undefined
  getAll(): ToolDef[]
  /** 作用域限制：allow/deny 过滤该作用域工具视图（仅作用域 ctx 下可用） */
  restrict(filter: ToolRestriction): () => void
  /** 单调守卫：工具执行前校验（返回 string = 拒绝原因） */
  guard(guard: ToolGuard): () => void
  materialize(filter?: unknown): { definitions: Record<string, unknown> }
  /** 作用域物化：mode allowlist + 权限 + 模型过滤（保留旧语义） */
  materializeScoped(opts: {
    mode?: string
    modelFilter?: unknown
    permissions?: PermissionSet
    toolAllowlist?: string[]
  }): Record<string, unknown>
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

/** 作用域工具限制（对齐 dsh ToolRestriction） */
export interface ToolRestriction {
  allow?: string[]
  deny?: string[]
}

/** 单调工具守卫（对齐 dsh ToolGuard）：void 放行，string 拒绝原因 */
export interface ToolGuard {
  (exec: { name: string; args: Record<string, unknown>; ctx: ToolContext }): void | string
}

/** 权限服务：规则引擎 + 审批 */
export interface PermissionService {
  evaluate(action: string, permission?: string): "allow" | "deny" | "ask"
  isAllowed(action: string, permission?: string): boolean
  needsApproval(action: string, resource?: string | string[]): boolean
  setRules(rules: PermissionRule[]): void
  addRule(rule: PermissionRule): void
}

/** 会话服务：CRUD（基于 project 维度，与 session/manager API 对齐） */
export interface SessionService {
  createSession(projectId: string, title?: string): Promise<SessionInfo>
  getSession(id: string): Promise<StoredSession | null>
  listSessions(projectId?: string): Promise<SessionInfo[]>
  deleteSession(id: string): Promise<void>
}

/** 记忆服务：全文搜索 + 写入（5 层 Provider 链在 initialize 装配，插件可 registerProvider 扩展） */
export interface MemoryService {
  initialize(sessionID: string, workspace: string): Promise<void>
  search(query: string, limit?: number): Promise<string>
  remember(content: string, sessionId: string): Promise<void>
  selectMemories(messages: unknown[], sessionID: string, tokenBudget?: number): Promise<string>
  shutdown(): Promise<void>
  /** 注册自定义记忆 Provider（插件扩展记忆来源），返回 disposer 可逆 */
  registerProvider(provider: import("../memory/types").MemoryProvider): () => void
  /** 获取底层 MemoryManager（Agent 构造共享，消除双实例） */
  getManager(): import("../memory/manager").MemoryManager | null
}

/** 动态记忆图谱服务：节点/边/查询/衰减 */
export interface DynamicMemoryService {
  initialize(workspace: string): Promise<void>
  addNode(content: string, type: string): Promise<MemoryNode>
  query(text: string, limit?: number): Promise<MemoryNode[]>
  activate(text: string, relevance?: unknown): Promise<{ nodes: MemoryNode[] }>
  performDecay(): Promise<number>
}

/** MCP 服务：服务器连接管理（工具为 MCP 元数据格式，执行经 MCP 代理） */
export interface MCPService {
  init(configs: MCPServerConfig[]): Promise<void>
  refresh(): Promise<void>
  listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}

/** Provider 目录服务：模型/能力数据（静态 ProviderCatalog 的实例化视图） */
export interface CatalogService {
  init(): void
  register(def: ProviderDef): void
  getModel(providerId: string, modelId: string): ModelDef | undefined
  listModels(providerId?: string): ModelDef[]
}

/** 全局配置服务：工作区/模式 */
export interface ConfigService {
  getWorkspace(): string
  getMode(): AgentMode
  getConfig(): AgentConfig
}

/** Agent 循环服务（对齐 dsh AgentFactory + 可替换循环实现） */
export interface AgentLoopService extends AgentFactory {
  setLoop(loop: import("../services/agent-loop").AgentLoopImpl): void
  getLoop(): import("../services/agent-loop").AgentLoopImpl
}

// ── 特色功能服务接口（实现于 services/ 同名文件，插件可替换实现） ──

/** Workflow 服务：代码级编排引擎（持有 WorkflowEngine，setEngine 可替换） */
export interface WorkflowService {
  execute(workflow: WorkflowDefinition, options?: WorkflowRunOptions): Promise<{ results: WorkflowResult[]; elapsedMs: number }>
  cancel(runId: string): boolean
  setEngine(engine: unknown): void
  getEngine(): import("../workflow/index").WorkflowEngine
}

/** Graph 服务：coding-task 图运行（运行状态进程内单一寻址，sidecar/api 消费） */
export interface GraphService {
  runCodingTask(
    request: string,
    config: Record<string, unknown>,
    options: { maxSteps?: number; testCommand?: string; maxTotalTokens?: number },
    runId: string,
    onEvent?: (evt: unknown) => void,
    onFinish?: {
      onResult?(result: import("../graph/types").GraphRunResult<import("../graph/templates/coding-task").CodingState>): void
      onEnd?(): void
    },
  ): void
  getStatus(runId: string): { runId: string; active: boolean }
  listRuns(graphId?: string): unknown[]
  stop(runId: string): boolean
}

/** 组合模式服务：phase 驱动软件开发工作流（skills/phaseOrder 可注册替换） */
export interface ComposeService {
  run(spec: string, config: AgentConfig): AsyncGenerator<import("../types").AgentEvent>
  start(spec: string): ComposeState
  getState(): ComposeState | null
  getCurrentSkill(): ComposeSkill | undefined
  advance(): ComposePhase | null
  goTo(phase: ComposePhase): void
  update(data: Partial<ComposeState>): void
  addCodeFile(file: string): void
  addReviewComment(comment: string): void
  addTestResult(result: string): void
  addDebugLog(log: string): void
  setVerificationPassed(passed: boolean): void
  complete(): ComposeState | null
  cancel(): ComposeState | null
  getHistory(): ComposeState[]
  toText(): string
  toSystemPrompt(): string
  getSkills(): Record<ComposePhase, ComposeSkill>
  registerPhase(phase: ComposePhase, skill: ComposeSkill): () => void
  /** 底层管理器（构造经 ctx.subagent 自动接线） */
  getManager(): import("../compose-mode").ComposeModeManager
}

/** 子 Agent 服务：Actor 模型生命周期（持有 SubagentManager 实例） */
export interface SubagentService {
  spawn(
    description: string,
    config: AgentConfig,
    options?: { parentId?: string; prompt?: string; model?: string; context?: "none" | "state" | "full"; mode?: "subagent" | "peer" },
  ): SubagentInfo
  wait(id: string, timeoutMs?: number): Promise<SubagentInfo>
  cancel(id: string): boolean
  getInfo(id: string): SubagentInfo | null
  getEvents(id: string): import("../types").AgentEvent[]
  list(filter?: { parentId?: string; status?: import("../orchestrate/subagent").SubagentStatus }): SubagentInfo[]
  listActive(): SubagentInfo[]
  listByParent(parentId: string): SubagentInfo[]
  cancelAllByParent(parentId: string): void
  cancelAll(): void
  onEvent(callback: (event: SubagentEvent) => void): void
  toText(): string
  getManager(): import("../orchestrate/subagent").SubagentManager
}

/** Goal 服务：任务完成度验证（持有 GoalJudge 实例） */
export interface GoalService {
  setJudgeConfig(config: GoalConfig): void
  bindSession(sessionID: string): void
  setGoal(description: string, timeoutMs?: number): Goal
  getActiveGoal(): Goal | null
  getAllGoals(): Goal[]
  cancelGoal(): boolean
  isTimedOut(goal: Goal): boolean
  evaluate(goal: Goal, messages: import("../llm/schema/messages").LLMMessage[], config?: GoalConfig): Promise<GoalEvaluation>
  quickCheck(goal: Goal, messages: import("../llm/schema/messages").LLMMessage[]): GoalEvaluation | null
  toSystemPrompt(): string
  toText(): string
  load(sessionID: string): Promise<void>
  save(): Promise<void>
  getJudge(): import("../orchestrate/goal-judge").GoalJudge
}

/** Dream/Distill 服务：记忆进化（持有 DreamDistillManager 实例） */
export interface DreamService {
  initialize(workspace: string): Promise<void>
  setLLMConfig(config: import("../orchestrate/dream-types").LLMConfig): void
  recordTurn(user: string, assistant: string): void
  shouldAutoDream(): boolean
  autoDream(): Promise<DreamResult | null>
  runDream(history: import("../llm/schema/messages").LLMMessage[], config: import("../orchestrate/dream-types").LLMConfig): Promise<DreamResult>
  distill(history: import("../llm/schema/messages").LLMMessage[], config: import("../orchestrate/dream-types").LLMConfig): Promise<unknown>
  getKnowledge(): KnowledgeEntry[]
  knowledgeToText(): string
  toSystemPrompt(): string
  toText(): string
  getGraphData(): { entities: GraphStore["entities"]; relationships: GraphStore["relationships"] }
  getManager(): import("../orchestrate/dream").DreamDistillManager
}

/** LSP 服务：代码智能（持有 LSPServerManager，setManager 可替换） */
export interface LSPService {
  getManager(): LSPServerManager
  setManager(manager: LSPServerManager): void
}

/** Skill 服务：扫描/加载（目录可配置，插件可注册目录） */
export interface SkillService {
  list(): Array<{ name: string; description: string; category?: string }>
  load(name: string): import("../skill/skill-loader").SkillContent | null
  loadFile(name: string, filePath: string): string | null
  getSkillDirs(): string[]
  addSkillDir(dir: string): () => void
}

/** 后台任务服务：队列 + Cron + 完成通知（订阅者模式） */
export interface BackgroundService {
  start(name: string, handler: () => Promise<string>): string
  getTaskStatus(id: string): BackgroundTask | undefined
  list(): BackgroundTask[]
  cleanup(olderThanMs?: number): void
  isSlowOperation(command: string): boolean
  schedule(cron: string, task: () => Promise<void>): string
  unschedule(id: string): boolean
  listCron(): import("../background/cron").CronTask[]
  addCron(id: string, expression: string, description: string, handler: () => Promise<void>): void
  removeCron(id: string): void
  setNotifier(notifier: unknown): void
}

/** 任务服务：TaskTracker + TaskPlanner 单一寻址（planners 注册表从 task-tool 迁入） */
export interface TaskService {
  initialize(sessionId: string): void
  create(summary: string, parentId?: string): Task
  updateStatus(id: string, status: TaskStatus): boolean
  updateSummary(id: string, summary: string): boolean
  addNote(id: string, note: string): boolean
  getTask(id: string): Task | null
  getAllTasks(): Task[]
  getActiveTasks(): Task[]
  toText(): string
  persist(): void
  createPlan(id: string): import("../task/planner").TaskPlanner
  definePlan(def: import("../task/planner").TaskDef): import("../task/planner").TaskPlanner
  executePlan(id: string): Promise<import("../task/planner").TaskState[]>
  getPlan(id: string): import("../task/planner").TaskPlanner | undefined
  deletePlan(id: string): boolean
  clearPlans(): void
}

/** 语音服务：VoiceRegistry 服务视图（引擎目录 + 工厂 + 会话管理） */
export interface VoiceService {
  initCatalog(): void
  listCatalog(): VoiceEngineDef[]
  getDefaults(): Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>
  setDefaults(defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>): void
  registerEngine(def: VoiceEngineDef): void
  registerFactory(implementation: string, kind: VoiceEngineKind, factory: unknown): void
  getSTTEngine(id?: string): unknown
  getTTSEngine(id?: string): unknown
  getVADEngine(id?: string): unknown
  isInitialized(): boolean
}
