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

/** 记忆服务：全文搜索 + 写入 */
export interface MemoryService {
  search(query: string, limit?: number): Promise<string>
  remember(content: string, sessionId: string): void
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
