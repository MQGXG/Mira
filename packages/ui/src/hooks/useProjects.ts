/**
 * useProjects — 项目管理 Hook
 */

import { useState, useEffect, useCallback } from "react"
import { ProjectService, type ProjectInfo } from "../services/project.service"

interface UseProjectsReturn {
  projects: ProjectInfo[]
  activeProject: string
  loading: boolean
  setActiveProject: (id: string) => void
  createProject: (name: string, workspacePath: string) => Promise<ProjectInfo>
  updateProject: (projectId: string, data: { name?: string; color?: string }) => Promise<void>
  deleteProject: (projectId: string) => Promise<void>
  hideProject: (projectId: string) => void
  refresh: () => Promise<ProjectInfo[]>
}

export function useProjects(initialProjectId?: string): UseProjectsReturn {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [activeProject, setActiveProjectState] = useState(initialProjectId || "")
  const [loading, setLoading] = useState(true)

  const loadProjects = useCallback(async () => {
    try {
      setLoading(true)
      const list = await ProjectService.list()
      setProjects(list)
      return list
    } catch {
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProjects()
    const timer = setInterval(loadProjects, 15000)
    return () => clearInterval(timer)
  }, [loadProjects])

  useEffect(() => {
    if (!activeProject && projects.length > 0) {
      setActiveProjectState(projects[0].project_id)
    }
  }, [projects, activeProject])

  const setActiveProject = useCallback((id: string) => {
    setActiveProjectState(id)
  }, [])

  const createProject = useCallback(async (name: string, workspacePath: string) => {
    const project = await ProjectService.create(name, workspacePath)
    await loadProjects()
    return project
  }, [loadProjects])

  const updateProject = useCallback(async (projectId: string, data: { name?: string; color?: string }) => {
    await ProjectService.update(projectId, data)
    await loadProjects()
  }, [loadProjects])

  const deleteProject = useCallback(async (projectId: string) => {
    await ProjectService.delete(projectId)
    await loadProjects()
    if (activeProject === projectId) {
      setActiveProjectState("")
    }
  }, [loadProjects, activeProject])

  const hideProject = useCallback((projectId: string) => {
    ProjectService.hide(projectId)
    loadProjects()
  }, [loadProjects])

  return {
    projects,
    activeProject,
    loading,
    setActiveProject,
    createProject,
    updateProject,
    deleteProject,
    hideProject,
    refresh: loadProjects,
  }
}
