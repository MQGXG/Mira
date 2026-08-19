/**
 * useSessions — 会话管理 Hook
 */

import { useState, useEffect, useCallback } from "react"
import { SessionService, type SessionInfo } from "../services/session.service"

interface UseSessionsOptions {
  projectId: string
  autoRefresh?: boolean
  refreshInterval?: number
}

interface UseSessionsReturn {
  sessions: SessionInfo[]
  loading: boolean
  createSession: (title?: string) => Promise<SessionInfo>
  deleteSession: (sessionId: string) => Promise<void>
  searchMessages: (query: string) => Promise<Array<{ session_id: string; session_title: string; message: { role: string; content: string; timestamp: string }; context: string }>>
  refresh: () => Promise<void>
}

export function useSessions({
  projectId,
  autoRefresh = true,
  refreshInterval = 10000,
}: UseSessionsOptions): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loading, setLoading] = useState(true)

  const loadSessions = useCallback(async () => {
    if (!projectId) {
      setSessions([])
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const list = await SessionService.list(projectId)
      setSessions(list)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadSessions()
    if (!autoRefresh) return
    const timer = setInterval(loadSessions, refreshInterval)
    return () => clearInterval(timer)
  }, [loadSessions, autoRefresh, refreshInterval])

  const createSession = useCallback(async (title?: string) => {
    const session = await SessionService.create(projectId, title)
    await loadSessions()
    return session
  }, [projectId, loadSessions])

  const deleteSession = useCallback(async (sessionId: string) => {
    await SessionService.delete(sessionId)
    await loadSessions()
  }, [loadSessions])

  const searchMessages = useCallback(async (query: string) => {
    return SessionService.search(query)
  }, [])

  return {
    sessions,
    loading,
    createSession,
    deleteSession,
    searchMessages,
    refresh: loadSessions,
  }
}
