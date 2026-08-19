/**
 * ACP (Agent Communication Protocol) 类型定义
 * 参考 Qwen Audio Agent 的 ACP 协议设计
 */

// ============================================================================
// Agent Card - Agent 能力描述
// ============================================================================

/** Agent 能力描述 */
export interface ACPCard {
  /** Agent 唯一标识 */
  agentId: string
  /** Agent 名称 */
  name: string
  /** Agent 描述 */
  description: string
  /** Agent 能力 */
  capabilities: ACPCapabilities
  /** Agent 版本 */
  version: string
  /** Agent 提供者 */
  provider?: string
  /** 支持的工具列表 */
  tools?: string[]
  /** 支持的协议 */
  protocols?: string[]
}

/** Agent 能力 */
export interface ACPCapabilities {
  /** 支持的工具 */
  tools: string[]
  /** 支持的协议 */
  protocols: string[]
  /** 最大并发任务数 */
  maxConcurrentTasks: number
  /** 是否支持流式输出 */
  streaming?: boolean
  /** 是否支持多模态 */
  multimodal?: boolean
  /** 是否支持代码执行 */
  codeExecution?: boolean
}

// ============================================================================
// ACP Message - 消息格式
// ============================================================================

/** ACP 消息角色 */
export type ACPMessageRole = 'user' | 'assistant' | 'system' | 'tool'

/** ACP 消息内容类型 */
export type ACPContentType = 'text' | 'image' | 'audio' | 'file' | 'code'

/** ACP 消息内容 */
export interface ACPContent {
  /** 内容类型 */
  type: ACPContentType
  /** 文本内容 */
  text?: string
  /** 二进制数据 (base64) */
  data?: string
  /** MIME 类型 */
  mimeType?: string
  /** 代码语言 (当 type=code 时) */
  language?: string
}

/** ACP 工具调用 */
export interface ACPToolCall {
  /** 工具调用 ID */
  id: string
  /** 工具名称 */
  name: string
  /** 工具参数 */
  arguments: Record<string, unknown>
  /** 工具调用状态 */
  status?: ACPToolCallStatus
}

/** 工具调用状态 */
export type ACPToolCallStatus = 'pending' | 'running' | 'completed' | 'failed'

/** ACP 工具结果 */
export interface ACPToolResult {
  /** 关联的工具调用 ID */
  toolCallId: string
  /** 结果内容 */
  content: string | ACPContent[]
  /** 是否是错误 */
  isError?: boolean
  /** 执行耗时 (ms) */
  durationMs?: number
}

/** ACP 消息 */
export interface ACPMessage {
  /** 消息 ID */
  id: string
  /** 消息角色 */
  role: ACPMessageRole
  /** 消息内容 */
  content: string | ACPContent[]
  /** 工具调用列表 */
  toolCalls?: ACPToolCall[]
  /** 工具结果列表 */
  toolResults?: ACPToolResult[]
  /** 消息元数据 */
  metadata?: ACPMessageMetadata
  /** 消息时间戳 */
  timestamp?: number
}

/** 消息元数据 */
export interface ACPMessageMetadata {
  /** Token 使用量 */
  tokens?: ACPTokenUsage
  /** 模型信息 */
  model?: string
  /** Provider 信息 */
  provider?: string
  /** 其他元数据 */
  [key: string]: unknown
}

/** Token 使用量 */
export interface ACPTokenUsage {
  /** 输入 token */
  prompt: number
  /** 输出 token */
  completion: number
  /** 总计 */
  total: number
}

// ============================================================================
// ACP Task - 任务管理
// ============================================================================

/** 任务类型 */
export type ACPTaskType = 'chat' | 'code' | 'research' | 'custom'

/** 任务状态 */
export type ACPTaskStatus = 
  | 'pending'     // 等待执行
  | 'running'     // 执行中
  | 'completed'   // 已完成
  | 'failed'      // 失败
  | 'cancelled'   // 已取消
  | 'paused'      // 已暂停

/** ACP 任务 */
export interface ACPTask {
  /** 任务 ID */
  taskId: string
  /** Agent ID */
  agentId: string
  /** 父任务 ID (如果是子任务) */
  parentId?: string
  /** 任务类型 */
  type: ACPTaskType
  /** 任务状态 */
  status: ACPTaskStatus
  /** 任务输入 */
  input: ACPTaskInput
  /** 任务输出 */
  output?: ACPTaskOutput
  /** 任务元数据 */
  metadata: ACPTaskMetadata
  /** 依赖的任务 ID 列表 */
  dependencies?: string[]
  /** 优先级 (0-10, 越高越优先) */
  priority?: number
}

/** 任务输入 */
export interface ACPTaskInput {
  /** 消息列表 */
  messages: ACPMessage[]
  /** 允许使用的工具 */
  tools?: string[]
  /** 系统提示 */
  systemPrompt?: string
  /** 工作目录 */
  workingDirectory?: string
}

/** 任务输出 */
export interface ACPTaskOutput {
  /** 消息列表 */
  messages: ACPMessage[]
  /** 最终结果 */
  result?: unknown
  /** 错误信息 */
  error?: string
}

/** 任务元数据 */
export interface ACPTaskMetadata {
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
  /** 完成时间 */
  completedAt?: number
  /** Token 使用量 */
  tokens?: ACPTokenUsage
  /** 执行耗时 (ms) */
  durationMs?: number
  /** 重试次数 */
  retryCount?: number
}

// ============================================================================
// ACP Event - 事件系统
// ============================================================================

/** 事件类型 */
export type ACPEventType =
  | 'task_created'
  | 'task_updated'
  | 'task_completed'
  | 'task_failed'
  | 'task_cancelled'
  | 'message_added'
  | 'tool_called'
  | 'tool_result'
  | 'permission_requested'
  | 'permission_resolved'
  | 'progress'

/** ACP 事件 */
export interface ACPEvent {
  /** 事件类型 */
  type: ACPEventType
  /** 任务 ID */
  taskId: string
  /** Agent ID */
  agentId: string
  /** 事件数据 */
  data: unknown
  /** 事件时间戳 */
  timestamp: number
}

// ============================================================================
// ACP Permission - 权限管理
// ============================================================================

/** 权限决策 */
export type ACPPermissionDecision = 'allow' | 'deny' | 'ask'

/** 权限请求 */
export interface ACPPermissionRequest {
  /** 请求 ID */
  id: string
  /** 关联的任务 ID */
  taskId: string
  /** 请求状态 */
  status: 'pending' | 'approved' | 'denied' | 'cancelled'
  /** 工具类别 */
  category: string
  /** 请求摘要 */
  summary: string
  /** 工具调用详情 */
  toolCall?: ACPToolCall
  /** 请求时间 */
  requestedAt: number
}

// ============================================================================
// ACP Session - 会话管理
// ============================================================================

/** 会话状态 */
export type ACPSessionStatus = 'active' | 'paused' | 'ended'

/** ACP 会话 */
export interface ACPSession {
  /** 会话 ID */
  sessionId: string
  /** Agent ID */
  agentId: string
  /** 会话状态 */
  status: ACPSessionStatus
  /** 会话消息历史 */
  messages: ACPMessage[]
  /** 会话创建时间 */
  createdAt: number
  /** 会话更新时间 */
  updatedAt: number
  /** 会话元数据 */
  metadata?: Record<string, unknown>
}

// ============================================================================
// ACP Coordinator - 协调器
// ============================================================================

/** 协调器决策类型 */
export type ACPDecisionMode = 'respond' | 'delegate'

/** 协调器决策 */
export interface ACPDecision {
  /** 工作 ID */
  workId: string
  /** 决策状态 */
  state: 'completed' | 'delegated'
  /** 决策模式 */
  mode: ACPDecisionMode
  /** 展示内容 */
  presentation: ACPPresentation
  /** 委派信息 (当 mode=delegate 时) */
  delegation?: ACPDelegation
}

/** 展示内容 */
export interface ACPPresentation {
  /** 语音内容 (适合 TTS) */
  speech: string
  /** 内联内容 (适合屏幕展示) */
  inline?: ACPInlineContent | null
}

/** 内联内容 */
export interface ACPInlineContent {
  /** 标题 */
  title: string
  /** 格式 */
  format: 'markdown' | 'code' | 'link'
  /** 内容 */
  content: string
}

/** 委派信息 */
export interface ACPDelegation {
  /** 委派 ID */
  delegationId: string
  /** 目标会话 ID */
  targetSessionId: string
  /** 委派标题 */
  title?: string
  /** 工作目录 */
  directory?: string
}

// ============================================================================
// ACP Work - 工作队列
// ============================================================================

/** 工作状态 */
export type ACPWorkStatus = 
  | 'queued'       // 排队中
  | 'running'      // 执行中
  | 'delegated'    // 已委派
  | 'finalizing'   // 完成中
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'cancelled'    // 已取消

/** ACP 工作项 */
export interface ACPWork {
  /** 工作 ID */
  workId: string
  /** 用户请求 */
  request: string
  /** 客观描述 */
  objective: string
  /** 工作状态 */
  status: ACPWorkStatus
  /** 关联的 Agent ID */
  agentId: string
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
  /** 完成时间 */
  completedAt?: number
  /** 结果 */
  result?: ACPPresentation
  /** 错误信息 */
  error?: string
  /** 委派信息 */
  delegation?: ACPDelegation
  /** 优先级 (0-10, 越高越优先) */
  priority?: number
  /** 依赖的任务 ID 列表 */
  dependencies?: string[]
}

// ============================================================================
// ACP 配置
// ============================================================================

/** ACP 配置 */
export interface ACPConfig {
  /** 协议版本 */
  protocolVersion: string
  /** Agent 配置 */
  agent: {
    /** Agent ID */
    id: string
    /** Agent 名称 */
    name: string
    /** 工作目录 */
    workingDirectory: string
  }
  /** 权限模式 */
  permissionMode: 'native' | 'full' | 'ask'
  /** 超时时间 (ms) */
  timeoutMs: number
  /** 最大重试次数 */
  maxRetries: number
  /** 是否启用流式输出 */
  streaming: boolean
}

// ============================================================================
// 工具函数类型
// ============================================================================

/** 工具上下文 */
export interface ACPToolContext {
  /** 任务 ID */
  taskId: string
  /** 会话 ID */
  sessionId: string
  /** Agent ID */
  agentId: string
  /** 工作目录 */
  workingDirectory: string
  /** 信号 (用于取消) */
  signal?: AbortSignal
}

/** 工具执行函数 */
export type ACPToolExecutor<TInput = Record<string, unknown>, TOutput = unknown> = (
  input: TInput,
  context: ACPToolContext,
) => Promise<TOutput>

/** ACP 工具定义 */
export interface ACPToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  /** 工具名称 */
  name: string
  /** 工具描述 */
  description: string
  /** 输入 Schema (JSON Schema) */
  inputSchema: Record<string, unknown>
  /** 工具执行函数 */
  execute: ACPToolExecutor<TInput, TOutput>
  /** 是否需要权限 */
  requiresPermission?: boolean
  /** 工具类别 */
  category?: string
}
