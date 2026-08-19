/**
 * Memory Service — 记忆系统
 */

export interface MemoryEntry {
  id: string
  content: string
  tags: string[]
}

export interface ProjectMemoryEntry {
  content: string
  source: string
  sessionId: string
}

export interface GraphDataFromDream {
  entities: Array<{ id: string; name: string; type: string; description?: string }>
  relationships: Array<{ source: string; target: string; relation: string }>
}

export const MemoryService = {
  async search(query: string, type?: string, limit?: number): Promise<MemoryEntry[]> {
    return window.electronAPI.memory.search(query, type, limit)
  },

  async searchByProject(query: string, projectId: string, limit?: number): Promise<ProjectMemoryEntry[]> {
    return window.electronAPI.memory.searchByProject(query, projectId, limit)
  },

  async getGraphData(): Promise<GraphDataFromDream> {
    return window.electronAPI.memory.getGraphData()
  },

  async status(): Promise<{ ready: boolean; count: number }> {
    return window.electronAPI.memory.status()
  },
}
