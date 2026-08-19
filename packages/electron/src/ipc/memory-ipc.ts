import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

export function registerMemoryIPC(): void {
  ipcMain.handle("memory:search", async (_, query: string, type?: string, limit?: number) => {
    const sm = getServerManager()
    if (!sm || !sm.running) return { results: [], error: "Sidecar not running" }
    try {
      return (await sm.request("POST", "/api/memory/search", { query, type, limit })) as { results: string[]; error: string | null }
    } catch (err: any) {
      return { results: [], error: err.message }
    }
  })

  ipcMain.handle("memory:searchByProject", async (_, query: string, projectId: string, limit?: number) => {
    const sm = getServerManager()
    if (!sm || !sm.running) return []
    try {
      return (await sm.request("POST", "/api/memory/search-by-project", { query, projectId, limit })) as Array<{ content: string; source: string; sessionId: string }>
    } catch {
      return []
    }
  })

  ipcMain.handle("memory:status", async () => {
    const sm = getServerManager()
    if (!sm || !sm.running) return { available: false, provider: "none" }
    try {
      return (await sm.request("GET", "/api/memory/status")) as { available: boolean; provider: string }
    } catch {
      return { available: false, provider: "none", error: "Sidecar unavailable" }
    }
  })

  ipcMain.handle("memory:getGraphData", async () => {
    const sm = getServerManager()
    if (!sm || !sm.running) return { entities: [], relationships: [] }
    try {
      return (await sm.request("GET", "/api/memory/graph")) as {
        entities: Array<{ id: string; name: string; type: string; description?: string }>
        relationships: Array<{ source: string; target: string; relation: string }>
      }
    } catch {
      return { entities: [], relationships: [] }
    }
  })
}
