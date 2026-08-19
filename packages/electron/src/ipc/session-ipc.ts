import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

/**
 * 会话/项目 IPC — 全部代理到 Sidecar HTTP（Sidecar 单写者）
 * 主进程不再直接持有 sql.js 数据库，避免双进程内存库互相覆盖。
 * Channel 名称与参数签名保持不变，preload/renderer 无需改动。
 */

function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not running")
  return {
    request: <T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> =>
      m.request(method, apiPath, body) as Promise<T>,
  }
}

export function registerSessionIPC(): void {
  ipcMain.handle("ts:listProjects", async () => {
    try { return await sm().request("GET", "/api/projects") } catch { return [] }
  })

  ipcMain.handle("ts:createProject", async (_, name: string, workspace: string) => {
    return await sm().request("POST", "/api/project/create", { name, workspace })
  })

  ipcMain.handle("ts:updateProject", async (_, projectId: string, data: { name?: string; workspace_path?: string }) => {
    return await sm().request("POST", "/api/project/update", { projectId, data })
  })

  ipcMain.handle("ts:deleteProject", async (_, projectId: string) => {
    return await sm().request("POST", "/api/project/delete", { projectId })
  })

  ipcMain.handle("ts:createSession", async (_, projectId: string, title?: string) => {
    return await sm().request("POST", "/api/session/create", { projectId, title })
  })

  ipcMain.handle("ts:listSessions", async (_, projectId?: string) => {
    try {
      const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""
      return await sm().request("GET", `/api/sessions${q}`)
    } catch { return [] }
  })

  ipcMain.handle("ts:getSessionMessages", async (_, sessionId: string) => {
    try {
      return await sm().request("GET", `/api/session/messages?sessionId=${encodeURIComponent(sessionId)}`)
    } catch { return [] }
  })

  ipcMain.handle("ts:deleteSession", async (_, sessionId: string) => {
    return await sm().request("POST", "/api/session/delete", { sessionId })
  })

  ipcMain.handle("ts:deleteSessions", async (_, sessionIds: string[]) => {
    return await sm().request("POST", "/api/session/delete-many", { sessionIds })
  })

  ipcMain.handle("ts:deleteMessage", async (_, sessionId: string, messageId: number) => {
    return await sm().request("POST", "/api/message/delete", { sessionId, messageId })
  })

  ipcMain.handle("ts:searchMessages", async (_, query: string) => {
    try {
      return await sm().request("POST", "/api/session/search", { query })
    } catch { return [] }
  })

  ipcMain.handle("ts:updateSession", async (_, sessionId: string, data: { title?: string }) => {
    return await sm().request("POST", "/api/session/update", { sessionId, data })
  })

  ipcMain.handle("ts:restoreSnapshot", async (_, snapshotId: string, workspace: string) => {
    return await sm().request("POST", "/api/session/restore-snapshot", { snapshotId, workspace })
  })
}
