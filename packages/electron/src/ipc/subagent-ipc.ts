import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

/**
 * 子 Agent IPC — 全部代理到 Sidecar HTTP（Sidecar 单写者）
 * 主进程不再创建 SubagentManager，避免双进程写 actor_registry。
 * Channel 名称与参数签名保持不变。
 */

function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not running")
  return {
    request: <T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> =>
      m.request(method, apiPath, body) as Promise<T>,
  }
}

export function registerSubagentIPC(): void {
  ipcMain.handle("subagent:spawn", async (_, description: string, config: Record<string, unknown>, options?: {
    parentId?: string
    prompt?: string
    model?: string
  }) => {
    return await sm().request("POST", "/api/subagent/spawn", { description, config, ...options })
  })

  ipcMain.handle("subagent:wait", async (_, id: string, timeoutMs?: number) => {
    return await sm().request("POST", "/api/subagent/wait", { id, timeoutMs })
  })

  ipcMain.handle("subagent:cancel", async (_, id: string) => {
    return await sm().request("POST", "/api/subagent/cancel", { id })
  })

  ipcMain.handle("subagent:get", async (_, id: string) => {
    return await sm().request("GET", `/api/subagent/get?id=${encodeURIComponent(id)}`)
  })

  ipcMain.handle("subagent:getEvents", async (_, id: string) => {
    return await sm().request("GET", `/api/subagent/get?id=${encodeURIComponent(id)}`)
  })

  ipcMain.handle("subagent:list", async (_, filter?: { parentId?: string; status?: string }) => {
    return await sm().request("POST", "/api/subagent/list", { filter })
  })

  ipcMain.handle("subagent:listActive", async () => {
    return await sm().request("GET", "/api/subagent/listActive")
  })

  ipcMain.handle("subagent:listByParent", async (_, parentId: string) => {
    return await sm().request("GET", `/api/subagent/listByParent?parentId=${encodeURIComponent(parentId)}`)
  })

  ipcMain.handle("subagent:cancelByParent", async (_, parentId: string) => {
    return await sm().request("POST", "/api/subagent/cancelByParent", { parentId })
  })

  ipcMain.handle("subagent:cancelAll", async () => {
    return await sm().request("POST", "/api/subagent/cancelAll")
  })

  ipcMain.handle("subagent:setMaxParallel", () => {
    return true
  })

  ipcMain.handle("subagent:toText", async () => {
    return await sm().request("GET", "/api/subagent/toText")
  })
}
