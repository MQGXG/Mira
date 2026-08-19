/**
 * Project Service — 项目管理
 */

import { PROJECT_COLORS } from "../theme/data-colors"

export interface ProjectInfo {
  project_id: string
  name: string
  workspace_path: string
  color: string
}

const COLORS = PROJECT_COLORS

function getColorFromStorage(projectId: string): string {
  try {
    const colorMap = JSON.parse(localStorage.getItem("project_colors") || "{}") as Record<string, string>
    return colorMap[projectId] || COLORS[Math.floor(Math.random() * COLORS.length)]
  } catch {
    return COLORS[0]
  }
}

function setColorToStorage(projectId: string, color: string): void {
  try {
    const colorMap = JSON.parse(localStorage.getItem("project_colors") || "{}") as Record<string, string>
    colorMap[projectId] = color
    localStorage.setItem("project_colors", JSON.stringify(colorMap))
  } catch { /* ignore */ }
}

function getHiddenProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem("hidden_projects") || "[]") as string[]
  } catch {
    return []
  }
}

function setHiddenProjects(ids: string[]): void {
  localStorage.setItem("hidden_projects", JSON.stringify(ids))
}

export const ProjectService = {
  async list(): Promise<ProjectInfo[]> {
    const raw = await window.electronAPI.ts.listProjects()
    const hidden = getHiddenProjects()
    return raw
      .filter((p) => !hidden.includes(p.project_id))
      .map((p) => ({
        project_id: p.project_id,
        name: p.name,
        workspace_path: p.workspace_path,
        color: getColorFromStorage(p.project_id),
      }))
  },

  async create(name: string, workspacePath: string): Promise<ProjectInfo> {
    const created = await window.electronAPI.ts.createProject(name, workspacePath)
    const color = getColorFromStorage(created.project_id)
    return {
      project_id: created.project_id,
      name,
      workspace_path: workspacePath,
      color,
    }
  },

  async update(projectId: string, data: { name?: string; color?: string }): Promise<void> {
    if (data.name) {
      await window.electronAPI.ts.updateProject(projectId, { name: data.name })
    }
    if (data.color) {
      setColorToStorage(projectId, data.color)
    }
  },

  async delete(projectId: string): Promise<void> {
    await window.electronAPI.ts.deleteProject(projectId)
  },

  hide(projectId: string): void {
    const hidden = getHiddenProjects()
    hidden.push(projectId)
    setHiddenProjects(hidden)
  },

  getColor(projectId: string): string {
    return getColorFromStorage(projectId)
  },

  setColor(projectId: string, color: string): void {
    setColorToStorage(projectId, color)
  },
}
