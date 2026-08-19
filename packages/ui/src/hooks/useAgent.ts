/**
 * useAgent — Agent 工具与执行 Hook
 */

import { useState, useEffect, useCallback } from "react"
import { AgentService, type ToolInfo, type SkillInfo } from "../services/agent.service"

interface UseToolsReturn {
  tools: ToolInfo[]
  loading: boolean
  refresh: () => Promise<void>
}

export function useTools(): UseToolsReturn {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(true)

  const loadTools = useCallback(async () => {
    try {
      setLoading(true)
      const list = await AgentService.listTools()
      setTools(list)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTools()
  }, [loadTools])

  return { tools, loading, refresh: loadTools }
}

interface UseSkillsReturn {
  skills: SkillInfo[]
  loading: boolean
}

export function useSkills(): UseSkillsReturn {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    AgentService.listSkills()
      .then(setSkills)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return { skills, loading }
}
