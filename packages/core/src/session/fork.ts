/**
 * Session Fork — 参考 MiMo-Code 的 Session Fork 机制
 * 支持从任意消息分支创建新会话
 */

import { randomUUID } from "crypto"

export interface ForkOptions {
  sourceSessionId: string
  forkAtMessageId?: string // 从哪条消息分叉，不指定则从最新
  newSessionTitle?: string
}

export interface ForkResult {
  newSessionId: string
  forkedFrom: string
  forkedAt: string // 分叉点的消息 ID
  messageCount: number // 继承的消息数量
}

interface Message {
  id: string
  role: "user" | "assistant" | "tool"
  content: string
  timestamp: string
  toolCallId?: string
}

export class SessionForkManager {
  private sessionStore: Map<string, Message[]> = new Map()

  /**
   * 从现有会话分叉
   * @param messages 原会话的消息列表
   * @param options 分叉选项
   * @returns 分叉结果
   */
  fork(messages: Message[], options: ForkOptions): ForkResult {
    const { sourceSessionId, forkAtMessageId, newSessionTitle } = options

    // 找到分叉点
    let forkIndex = messages.length
    if (forkAtMessageId) {
      const idx = messages.findIndex(m => m.id === forkAtMessageId)
      if (idx >= 0) {
        forkIndex = idx + 1 // 包含分叉点消息
      }
    }

    // 复制消息（深拷贝）
    const forkedMessages = messages.slice(0, forkIndex).map(m => ({
      ...m,
      id: `${m.id}_fork_${Date.now().toString(36)}`, // 新 ID 避免冲突
    }))

    // 创建新会话
    const newSessionId = `ses_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    this.sessionStore.set(newSessionId, forkedMessages)

    return {
      newSessionId,
      forkedFrom: sourceSessionId,
      forkedAt: forkAtMessageId || messages[messages.length - 1]?.id || "",
      messageCount: forkedMessages.length,
    }
  }

  /**
   * 获取分叉会话的消息
   */
  getMessages(sessionId: string): Message[] {
    return this.sessionStore.get(sessionId) || []
  }

  /**
   * 添加消息到会话
   */
  addMessage(sessionId: string, message: Message): void {
    const messages = this.sessionStore.get(sessionId) || []
    messages.push(message)
    this.sessionStore.set(sessionId, messages)
  }

  /**
   * 获取会话信息
   */
  getSessionInfo(sessionId: string): {
    exists: boolean
    messageCount: number
    firstMessage?: Message
    lastMessage?: Message
  } {
    const messages = this.sessionStore.get(sessionId)
    if (!messages) {
      return { exists: false, messageCount: 0 }
    }

    return {
      exists: true,
      messageCount: messages.length,
      firstMessage: messages[0],
      lastMessage: messages[messages.length - 1],
    }
  }

  /**
   * 列出所有会话
   */
  listSessions(): Array<{
    sessionId: string
    messageCount: number
    lastActivity: string
  }> {
    return Array.from(this.sessionStore.entries()).map(([id, messages]) => ({
      sessionId: id,
      messageCount: messages.length,
      lastActivity: messages[messages.length - 1]?.timestamp || "",
    }))
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    return this.sessionStore.delete(sessionId)
  }

  /**
   * 合并两个会话
   */
  merge(sourceSessionId: string, targetSessionId: string, atMessageId?: string): boolean {
    const sourceMessages = this.sessionStore.get(sourceSessionId)
    const targetMessages = this.sessionStore.get(targetSessionId)

    if (!sourceMessages || !targetMessages) {
      return false
    }

    let insertIndex = targetMessages.length
    if (atMessageId) {
      const idx = targetMessages.findIndex(m => m.id === atMessageId)
      if (idx >= 0) {
        insertIndex = idx + 1
      }
    }

    // 插入源会话的消息
    const newMessages = [
      ...targetMessages.slice(0, insertIndex),
      ...sourceMessages.map(m => ({ ...m, id: `${m.id}_merged_${Date.now().toString(36)}` })),
      ...targetMessages.slice(insertIndex),
    ]

    this.sessionStore.set(targetSessionId, newMessages)
    return true
  }
}

export function createSessionForkManager(): SessionForkManager {
  return new SessionForkManager()
}
