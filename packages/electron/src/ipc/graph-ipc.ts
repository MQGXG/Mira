import { ipcMain, BrowserWindow } from "electron"
import { getServerManager, connectAndGetChannel } from "./sidecar-bridge"

/**
 * Graph IPC — 全部代理到 Sidecar HTTP（Sidecar 单写者）
 * 主进程不再直接运行 StateGraph / Agent（避免写 sessions/messages 等表）。
 * runCodingTask 复用 SSE 通道，事件经 webContents 转发到前端。
 */

function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not running")
  return {
    request: <T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> =>
      m.request(method, apiPath, body) as Promise<T>,
  }
}

export function registerGraphIPC(): void {
  // ── 启动编码任务图（SSE） ─────────────────────────
  ipcMain.handle("graph:runCodingTask", async (event, request: string, config: Record<string, unknown>, options?: {
    maxSteps?: number
    testCommand?: string
    maxTotalTokens?: number
  }) => {
    const server = getServerManager()
    if (!server) throw new Error("Sidecar not running")
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("Cannot get sender window")

    let runId = ""

    runId = await connectAndGetChannel(
      server,
      {
        request,
        config,
        maxSteps: options?.maxSteps,
        testCommand: options?.testCommand,
        maxTotalTokens: options?.maxTotalTokens,
      },
      (data) => {
        if (!window.isDestroyed()) {
          window.webContents.send("agent:event", runId, data)
        }
      },
      () => { /* 流结束，无需额外处理 */ },
      (err) => {
        console.error(`[Graph] Stream error: ${err.message}`)
        if (!window.isDestroyed()) {
          window.webContents.send("agent:event", runId, { type: "error", message: err.message })
        }
      },
    )

    return { runId }
  })

  // ── 查询运行状态 ───────────────────────────────
  ipcMain.handle("graph:getStatus", async (_, runId: string) => {
    try {
      return await sm().request("GET", `/api/graph/status?runId=${encodeURIComponent(runId)}`)
    } catch { return { runId, active: false } }
  })

  // ── 列出历史运行（检查点） ─────────────────────
  ipcMain.handle("graph:listRuns", async (_, graphId?: string) => {
    try {
      const q = graphId ? `?graphId=${encodeURIComponent(graphId)}` : ""
      return await sm().request("GET", `/api/graph/listRuns${q}`)
    } catch { return [] }
  })

  // ── 停止运行 ───────────────────────────────────
  ipcMain.handle("graph:stop", async (_, runId: string) => {
    try {
      return await sm().request("POST", "/api/graph/stop", { runId })
    } catch { return false }
  })
}
