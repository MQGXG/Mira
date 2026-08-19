import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

/**
 * Task IPC — 全部代理到 Sidecar HTTP（Sidecar 单写者）
 * 主进程不再直接操作 taskTracker（原从未 initialize，功能失效），
 * sidecar 的 taskTracker 已在 stream 初始化，任务数据真实落盘。
 */

function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not running")
  return {
    request: <T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> =>
      m.request(method, apiPath, body) as Promise<T>,
  }
}

export function registerTaskIPC(): void {
  ipcMain.handle("task:create", async (_, summary: string, parentId?: string) => {
    return await sm().request("POST", "/api/task/create", { summary, parentId })
  })

  ipcMain.handle("task:updateStatus", async (_, taskId: string, status: string) => {
    return await sm().request("POST", "/api/task/updateStatus", { taskId, status })
  })

  ipcMain.handle("task:updateSummary", async (_, taskId: string, summary: string) => {
    return await sm().request("POST", "/api/task/updateSummary", { taskId, summary })
  })

  ipcMain.handle("task:addNote", async (_, taskId: string, note: string) => {
    return await sm().request("POST", "/api/task/addNote", { taskId, note })
  })

  ipcMain.handle("task:get", async (_, taskId: string) => {
    return await sm().request("GET", `/api/task/get?taskId=${encodeURIComponent(taskId)}`)
  })

  ipcMain.handle("task:list", async (_, status?: string) => {
    const q = status ? `?status=${encodeURIComponent(status)}` : ""
    return await sm().request("GET", `/api/task/list${q}`)
  })

  ipcMain.handle("task:listActive", async () => {
    return await sm().request("GET", "/api/task/listActive")
  })

  ipcMain.handle("task:toText", async () => {
    return await sm().request("GET", "/api/task/toText")
  })
}
