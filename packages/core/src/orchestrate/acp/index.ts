/**
 * ACP (Agent Communication Protocol) 模块
 * 参考 Qwen Audio Agent 的 ACP 协议设计
 */

// 导出类型
export type {
  // Agent Card
  ACPCard,
  ACPCapabilities,

  // 消息
  ACPMessage,
  ACPMessageRole,
  ACPContent,
  ACPContentType,
  ACPToolCall,
  ACPToolCallStatus,
  ACPToolResult,
  ACPMessageMetadata,
  ACPTokenUsage,

  // 任务
  ACPTask,
  ACPTaskType,
  ACPTaskStatus,
  ACPTaskInput,
  ACPTaskOutput,
  ACPTaskMetadata,

  // 事件
  ACPEvent,
  ACPEventType,

  // 权限
  ACPPermissionRequest,
  ACPPermissionDecision,

  // 会话
  ACPSession,
  ACPSessionStatus,

  // 协调器
  ACPDecision,
  ACPDecisionMode,
  ACPPresentation,
  ACPInlineContent,
  ACPDelegation,

  // 工作
  ACPWork,
  ACPWorkStatus,

  // 配置
  ACPConfig,

  // 工具
  ACPToolContext,
  ACPToolExecutor,
  ACPToolDefinition,
} from './types'

// 导出消息工具函数
export {
  // 创建函数
  createTextMessage,
  createMultiContentMessage,
  createToolCallMessage,
  createToolResultMessage,
  createSystemMessage,
  createUserMessage,
  createAssistantMessage,

  // 内容创建
  createTextContent,
  createCodeContent,
  createImageContent,
  createAudioContent,
  createFileContent,

  // 工具调用创建
  createToolCall,
  createToolResult,

  // 转换函数
  extractTextFromMessage,
  extractCodeFromMessage,
  getToolCallsFromMessage,
  getToolResultsFromMessage,
  toLLMMessage,
  toLLMMessages,

  // 验证函数
  validateMessage,
  validateMessages,
} from './message'

// 导出 Work 状态机
export {
  WorkStateMachine,
  globalWorkStateMachine,
  generateWorkId,
  isTerminalStatus,
  isActiveStatus,
  getStatusLabel,
  getStatusColor,
} from './work-state-machine'
