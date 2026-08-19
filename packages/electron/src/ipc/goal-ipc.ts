import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

/**
 * Goal IPC — 全部代理到 Sidecar HTTP（Sidecar 单写者）
 * 主进程不再初始化 sql.js / 创建 GoalJudge，避免双进程写 goals 表。
 * 原 initGoalIPC（显式 initDatabase）为死代码，已移除。
 */

function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not running")
  return {
    request: <T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> =>
      m.request(method, apiPath, body) as Promise<T>,
  }
}

export function registerGoalIPC(): void {
  ipcMain.handle("goal:set", async (_, description: string, timeoutMs?: number) => {
    return await sm().request("POST", "/api/goal/set", { description, timeoutMs })
  })

  ipcMain.handle("goal:getActive", async () => {
    return await sm().request("GET", "/api/goal/getActive")
  })

  ipcMain.handle("goal:list", async () => {
    return await sm().request("GET", "/api/goal/list")
  })

  ipcMain.handle("goal:cancel", async () => {
    return await sm().request("POST", "/api/goal/cancel")
  })

  ipcMain.handle("goal:toText", async () => {
    return await sm().request("GET", "/api/goal/toText")
  })

  ipcMain.handle("goal:load", async (_, sessionID: string) => {
    return await sm().request("POST", "/api/goal/load", { sessionId: sessionID })
  })

  ipcMain.handle("goal:save", async () => {
    return await sm().request("POST", "/api/goal/save")
  })
}
