/**
 * ACP 消息工具函数
 * 参考 Qwen Audio Agent 的消息格式设计
 */

import { randomUUID } from 'crypto'
import type {
  ACPMessage,
  ACPMessageRole,
  ACPContent,
  ACPToolCall,
  ACPToolResult,
  ACPContentType,
  ACPTokenUsage,
} from './types'

// ============================================================================
// 消息创建函数
// ============================================================================

/**
 * 创建文本消息
 */
export function createTextMessage(
  role: ACPMessageRole,
  text: string,
  options?: {
    id?: string
    metadata?: Record<string, unknown>
    tokens?: ACPTokenUsage
  },
): ACPMessage {
  return {
    id: options?.id || randomUUID(),
    role,
    content: text,
    timestamp: Date.now(),
    metadata: {
      ...options?.metadata,
      tokens: options?.tokens,
    },
  }
}

/**
 * 创建多内容消息
 */
export function createMultiContentMessage(
  role: ACPMessageRole,
  contents: ACPContent[],
  options?: {
    id?: string
    metadata?: Record<string, unknown>
  },
): ACPMessage {
  return {
    id: options?.id || randomUUID(),
    role,
    content: contents,
    timestamp: Date.now(),
    metadata: options?.metadata,
  }
}

/**
 * 创建工具调用消息
 */
export function createToolCallMessage(
  toolCalls: ACPToolCall[],
  options?: {
    id?: string
    text?: string
    metadata?: Record<string, unknown>
  },
): ACPMessage {
  return {
    id: options?.id || randomUUID(),
    role: 'assistant',
    content: options?.text || '',
    toolCalls,
    timestamp: Date.now(),
    metadata: options?.metadata,
  }
}

/**
 * 创建工具结果消息
 */
export function createToolResultMessage(
  toolResults: ACPToolResult[],
  options?: {
    id?: string
    metadata?: Record<string, unknown>
  },
): ACPMessage {
  return {
    id: options?.id || randomUUID(),
    role: 'tool',
    content: '',
    toolResults,
    timestamp: Date.now(),
    metadata: options?.metadata,
  }
}

/**
 * 创建系统消息
 */
export function createSystemMessage(
  content: string,
  options?: {
    id?: string
    metadata?: Record<string, unknown>
  },
): ACPMessage {
  return createTextMessage('system', content, options)
}

/**
 * 创建用户消息
 */
export function createUserMessage(
  content: string | ACPContent[],
  options?: {
    id?: string
    metadata?: Record<string, unknown>
  },
): ACPMessage {
  if (typeof content === 'string') {
    return createTextMessage('user', content, options)
  }
  return createMultiContentMessage('user', content, options)
}

/**
 * 创建助手消息
 */
export function createAssistantMessage(
  content: string | ACPContent[],
  options?: {
    id?: string
    toolCalls?: ACPToolCall[]
    metadata?: Record<string, unknown>
    tokens?: ACPTokenUsage
  },
): ACPMessage {
  if (options?.toolCalls?.length) {
    return createToolCallMessage(options.toolCalls, {
      id: options?.id,
      text: typeof content === 'string' ? content : '',
      metadata: {
        ...options?.metadata,
        tokens: options?.tokens,
      },
    })
  }
  if (typeof content === 'string') {
    return createTextMessage('assistant', content, {
      id: options?.id,
      metadata: options?.metadata,
      tokens: options?.tokens,
    })
  }
  return createMultiContentMessage('assistant', content, {
    id: options?.id,
    metadata: {
      ...options?.metadata,
      tokens: options?.tokens,
    },
  })
}

// ============================================================================
// 内容创建函数
// ============================================================================

/**
 * 创建文本内容
 */
export function createTextContent(text: string): ACPContent {
  return { type: 'text', text }
}

/**
 * 创建代码内容
 */
export function createCodeContent(code: string, language?: string): ACPContent {
  return { type: 'code', text: code, language }
}

/**
 * 创建图片内容
 */
export function createImageContent(
  data: string,
  mimeType: string = 'image/png',
): ACPContent {
  return { type: 'image', data, mimeType }
}

/**
 * 创建音频内容
 */
export function createAudioContent(
  data: string,
  mimeType: string = 'audio/wav',
): ACPContent {
  return { type: 'audio', data, mimeType }
}

/**
 * 创建文件内容
 */
export function createFileContent(
  data: string,
  mimeType: string,
  fileName?: string,
): ACPContent {
  return { type: 'file', data, mimeType, text: fileName }
}

// ============================================================================
// 工具调用创建函数
// ============================================================================

/**
 * 创建工具调用
 */
export function createToolCall(
  name: string,
  arguments_: Record<string, unknown>,
  options?: {
    id?: string
    status?: ACPToolCall['status']
  },
): ACPToolCall {
  return {
    id: options?.id || randomUUID(),
    name,
    arguments: arguments_,
    status: options?.status || 'pending',
  }
}

/**
 * 创建工具结果
 */
export function createToolResult(
  toolCallId: string,
  content: string | ACPContent[],
  options?: {
    isError?: boolean
    durationMs?: number
  },
): ACPToolResult {
  return {
    toolCallId,
    content,
    isError: options?.isError || false,
    durationMs: options?.durationMs,
  }
}

// ============================================================================
// 消息转换函数
// ============================================================================

/**
 * 提取消息文本内容
 */
export function extractTextFromMessage(message: ACPMessage): string {
  if (typeof message.content === 'string') {
    return message.content
  }
  return message.content
    .filter((c): c is ACPContent & { type: 'text' | 'code' } => 
      c.type === 'text' || c.type === 'code'
    )
    .map(c => c.text || '')
    .join('\n')
}

/**
 * 提取消息中的代码
 */
export function extractCodeFromMessage(message: ACPMessage): string {
  if (typeof message.content === 'string') {
    return ''
  }
  return message.content
    .filter((c): c is ACPContent & { type: 'code' } => c.type === 'code')
    .map(c => c.text || '')
    .join('\n')
}

/**
 * 获取消息中的所有工具调用
 */
export function getToolCallsFromMessage(message: ACPMessage): ACPToolCall[] {
  return message.toolCalls || []
}

/**
 * 获取消息中的所有工具结果
 */
export function getToolResultsFromMessage(message: ACPMessage): ACPToolResult[] {
  return message.toolResults || []
}

/**
 * 转换为 LLM 消息格式
 */
export function toLLMMessage(message: ACPMessage): {
  role: string
  content: string
  tool_call_id?: string
  name?: string
} {
  const base = {
    role: message.role,
    content: extractTextFromMessage(message),
  }

  if (message.role === 'tool' && message.toolResults?.length) {
    return {
      ...base,
      tool_call_id: message.toolResults[0].toolCallId,
    }
  }

  return base
}

/**
 * 批量转换为 LLM 消息格式
 */
export function toLLMMessages(messages: ACPMessage[]): Array<{
  role: string
  content: string
  tool_call_id?: string
  name?: string
}> {
  return messages.map(toLLMMessage)
}

// ============================================================================
// 消息验证函数
// ============================================================================

/**
 * 验证消息格式
 */
export function validateMessage(message: ACPMessage): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!message.id) {
    errors.push('消息缺少 ID')
  }

  if (!['user', 'assistant', 'system', 'tool'].includes(message.role)) {
    errors.push(`无效的消息角色: ${message.role}`)
  }

  if (typeof message.content !== 'string' && !Array.isArray(message.content)) {
    errors.push('消息内容必须是字符串或数组')
  }

  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      if (!call.id || !call.name) {
        errors.push('工具调用缺少 ID 或名称')
      }
    }
  }

  if (message.toolResults) {
    for (const result of message.toolResults) {
      if (!result.toolCallId) {
        errors.push('工具结果缺少 toolCallId')
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * 验证消息列表
 */
export function validateMessages(messages: ACPMessage[]): {
  valid: boolean
  errors: string[]
  invalidIndices: number[]
} {
  const allErrors: string[] = []
  const invalidIndices: number[] = []

  messages.forEach((message, index) => {
    const result = validateMessage(message)
    if (!result.valid) {
      invalidIndices.push(index)
      allErrors.push(`消息 ${index}: ${result.errors.join(', ')}`)
    }
  })

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    invalidIndices,
  }
}
