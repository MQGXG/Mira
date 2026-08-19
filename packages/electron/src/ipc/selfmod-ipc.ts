/**
 * 运行期自修改 IPC — 代理到 sidecar HTTP（/api/selfmod/*）
 * 渲染进程经此拉取动态插件状态与 client half 源码（UI 插件）
 */

import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

export function registerSelfModIPC(): void {
  // 运行期自修改状态
  ipcMain.handle("selfmod:status", async () => {
    const sm = getServerManager()
    if (!sm || !sm.running) return { enabled: false }
    try {
      return (await sm.request("GET", "/api/selfmod/status")) as { enabled: boolean }
    } catch {
      return { enabled: false }
    }
  })

  // 列出会话动态插件
  ipcMain.handle("selfmod:listPlugins", async (_e, sessionId: string) => {
    const sm = getServerManager()
    if (!sm || !sm.running) return { plugins: [], enabled: false }
    try {
      return (await sm.request("POST", "/api/selfmod/plugins", { sessionId })) as { plugins: unknown[]; enabled: boolean }
    } catch {
      return { plugins: [], enabled: false }
    }
  })

  // 获取插件 client half 源码（渲染进程沙箱执行）
  ipcMain.handle("selfmod:getClientCode", async (_e, body: { sessionId: string; pluginId: string; packageId?: string }) => {
    const sm = getServerManager()
    if (!sm || !sm.running) return { ok: false, error: "Sidecar not running" }
    try {
      return (await sm.request("POST", "/api/selfmod/plugin/client", body)) as { ok: boolean; clientCode?: string; error?: string }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
