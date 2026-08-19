/**
 * Session Service — 会话管理
 */

export interface SessionInfo {
  session_id: string
  project_id?: string
  title: string
  kind: string
  workspace_path: string
  message_count: number
  updated_at: string
  /** 会话累计成本（美元） */
  cost?: number
  /** 会话累计 token 用量 */
  tokens?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

export interface SessionMessage {
  id: number
  role: string
  content: string
  retryCount?: number
  timestamp?: string
}

export interface SearchResult {
  session_id: string
  session_title: string
  message: { role: string; content: string; timestamp: string }
  context: string
}

export const SessionService = {
  async list(projectId?: string): Promise<SessionInfo[]> {
    return window.electronAPI.ts.listSessions(projectId)
  },

  async create(projectId: string, title?: string): Promise<SessionInfo> {
    return window.electronAPI.ts.createSession(projectId, title)
  },

  async delete(sessionId: string): Promise<void> {
    return window.electronAPI.ts.deleteSession(sessionId)
  },

  async deleteMany(sessionIds: string[]): Promise<void> {
    if (!sessionIds.length) return;
    return window.electronAPI.ts.deleteSessions(sessionIds)
  },

  async deleteMessage(sessionId: string, messageId: number): Promise<void> {
    return window.electronAPI.ts.deleteMessage(sessionId, messageId)
  },

  async getMessages(sessionId: string): Promise<SessionMessage[]> {
    return window.electronAPI.ts.getSessionMessages(sessionId)
  },

  async search(query: string): Promise<SearchResult[]> {
    return window.electronAPI.ts.searchMessages(query)
  },

  async update(sessionId: string, data: { title?: string }): Promise<void> {
    return window.electronAPI.ts.updateSession(sessionId, data)
  },
}
