/**
 * Sidecar Bridge — Electron IPC ↔ Core HTTP 代理层
 *
 * 保留现有 IPC 接口不变，底层改为 HTTP 通信
 * 支持：健康检查自动重连、SSE 事件透传、权限回复代理
 */

import { ServerManager } from "@mira/core"
import { ipcMain, BrowserWindow, app } from "electron"
import { join } from "path"

interface SSESession {
  channel: string
  destroy: () => void
}

const sseSessions = new Map<string, SSESession>()
let serverManager: ServerManager | null = null

export function getServerManager(): ServerManager | null {
  return serverManager
}
let healthCheckTimer: ReturnType<typeof setInterval> | null = null

const HEALTH_CHECK_INTERVAL = 10_000
const RECONNECT_DELAY = 2_000
/** 连续失败达到该次数才强制重建（避免瞬时抖动触发重启） */
const MAX_HEALTH_FAILURES = 2
/** 自动重连最大尝试次数，超限后停止并提示用户重启（避免无限进程风暴） */
const MAX_RECONNECT_ATTEMPTS = 5
/** 重连退避封顶（毫秒） */
const MAX_RECONNECT_DELAY = 30_000
let isReconnecting = false
let consecutiveFailures = 0
let reconnectAttempts = 0

/** 向所有窗口广播 sidecar 状态（断连/重连中/恢复/放弃），供前端显示遮罩与自动刷新 */
function broadcastSidecarStatus(status: "connected" | "reconnecting" | "failed"): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("sidecar:status", status)
    }
  }
}

// ── 生命周期 ──────────────────────────────────────────

export async function startSidecar(port = 0): Promise<{ port: number; token: string }> {
  if (serverManager) throw new Error("Sidecar already running")

  // 开发模式用 tsx 跑 TypeScript 源码，生产用编译后的 JS
  const useTsx = process.env.NODE_ENV !== "production" && !app.isPackaged
  const userData = app.getPath("userData")

  // 本地模型资源目录：打包后位于 process.resourcesPath/models，开发时位于仓库内 resources/models
  const modelDir = app.isPackaged
    ? join(process.resourcesPath, "models")
    : join(app.getAppPath(), "resources", "models")

  serverManager = new ServerManager({ port, useTsx, userData, modelDir, version: app.getVersion() })
  const info = await serverManager.start()
  console.log(`[Sidecar] Core server ready on port ${info.port}`)
  broadcastSidecarStatus("connected")

  // 诊断：启动后立即自测健康检查，区分"启动即不通" vs "运行中变不通"
  try {
    await serverManager.request("GET", "/api/health", undefined, 5_000)
    console.log("[Sidecar] Startup health check OK")
  } catch (err) {
    console.error(`[Sidecar] Startup health check FAILED: ${err instanceof Error ? err.message : String(err)}`)
  }

  startHealthCheck()
  return info
}

export async function stopSidecar(): Promise<void> {
  stopHealthCheck()

  sseSessions.forEach((s) => s.destroy())
  sseSessions.clear()

  if (serverManager) {
    await serverManager.stop()
    serverManager = null
  }
  console.log("[Sidecar] Stopped")
}

// ── 健康检查 + 自动重连 ──────────────────────────────

function startHealthCheck(): void {
  stopHealthCheck()
  healthCheckTimer = setInterval(async () => {
    const sm = serverManager
    if (!sm) return

    try {
      await sm.request("GET", "/api/health", undefined, 5_000)
      if (consecutiveFailures > 0) {
        consecutiveFailures = 0
        broadcastSidecarStatus("connected")
      }
    } catch {
      consecutiveFailures++
      console.warn(`[Sidecar] Health check failed (${consecutiveFailures}/${MAX_HEALTH_FAILURES}), attempting reconnect...`)
      if (consecutiveFailures >= MAX_HEALTH_FAILURES) {
        consecutiveFailures = 0
        void reconnect()
      }
    }
  }, HEALTH_CHECK_INTERVAL)
}

function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
}

async function reconnect(): Promise<void> {
  if (isReconnecting) return
  isReconnecting = true
  broadcastSidecarStatus("reconnecting")
  reconnectAttempts++

  try {
    await new Promise((r) => setTimeout(r, RECONNECT_DELAY))
    const sm = serverManager
    if (!sm) return

    // 强制重建：不依赖 running 判断（壳进程存活不代表底层服务可用）
    await sm.stop()
    const info = await sm.start()
    console.log(`[Sidecar] Core server restarted on port ${info.port}`)

    // Core 重启后旧 channel 全部失效，清理残留 SSE 会话
    sseSessions.forEach((s) => s.destroy())
    sseSessions.clear()

    // 验证恢复（sm.start 等待新进程 ready，这里打到的是新端口）
    await sm.request("GET", "/api/health", undefined, 5_000)
    console.log("[Sidecar] Reconnected to Core server")
    reconnectAttempts = 0
    broadcastSidecarStatus("connected")
  } catch (err) {
    console.error(`[Sidecar] Reconnect failed: ${String(err)}`)
    broadcastSidecarStatus("reconnecting")

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[Sidecar] Reconnect aborted after ${reconnectAttempts} attempts; please restart the app`)
      // 广播终态失败：让前端显示 failed 遮罩（此前仅 log，App 侧 failed phase 无数据源）
      broadcastSidecarStatus("failed")
      isReconnecting = false
      return
    }

    // 指数退避：2s → 4s → 8s → 16s → 30s（封顶）
    const delay = Math.min(RECONNECT_DELAY * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_DELAY)
    setTimeout(() => { isReconnecting = false; void reconnect() }, delay)
    return
  }

  isReconnecting = false
}

function getSM(): ServerManager {
  if (!serverManager) throw new Error("Sidecar not started")
  return serverManager
}

// ── SSE 流管理 ────────────────────────────────────────

interface PendingStream {
  resolve: (channel: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let pendingStreamId = 0
const pendingStreams = new Map<number, PendingStream>()

/**
 * 建立 SSE 连接到 Core，等待 channel 事件后返回
 * 每个连接独立 resolution，避免并发冲突
 */
export function connectAndGetChannel(
  sm: ServerManager,
  body: Record<string, unknown>,
  onEvent: (data: unknown) => void,
  onDone: () => void,
  onError: (err: Error) => void,
): Promise<string> {
  const id = ++pendingStreamId
  let cleanup: (() => void) | null = null

  return new Promise((resolve, reject) => {
    // 30 秒超时（Core 冷启动/GC 暂停可能需要较长时间），超时后清理底层连接
    const timer = setTimeout(() => {
      pendingStreams.delete(id)
      cleanup?.() // 清理底层 SSE 连接，避免超时后 socket 泄漏
      console.error(`[Sidecar] SSE channel timeout for stream #${id} after 30s`)
      reject(new Error("SSE channel timeout"))
    }, 30_000)

    pendingStreams.set(id, { resolve, reject, timer })

    sm.connectSSE(
      "/api/agent/stream",
      body,
      (eventType, data) => {
        if (eventType === "channel") {
          const pending = pendingStreams.get(id)
          if (pending) {
            clearTimeout(pending.timer)
            pendingStreams.delete(id)
            pending.resolve((data as { channel: string }).channel)
          }
          return
        }
        onEvent(data)
      },
      () => {
        onDone()
        const pending = pendingStreams.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingStreams.delete(id)
          pending.reject(new Error("Stream ended before channel event"))
        }
      },
      (err) => {
        console.error(`[Sidecar] connectSSE error for stream #${id}: ${err.message}`)
        onError(err)
        const pending = pendingStreams.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingStreams.delete(id)
          pending.reject(err)
        }
      },
    )
      .then((disconnect) => {
        cleanup = disconnect
      })
      .catch((err: Error) => {
        // waitForReady 失败等同步错误：立即失败，避免挂到超时
        const pending = pendingStreams.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          pendingStreams.delete(id)
          pending.reject(err)
        }
      })
  })
}

// ── IPC Handler 注册 ──────────────────────────────────

export function registerSidecarIPCHandlers(): void {
  const sm = getSM()

  // ── 工具 / Agent 列表（同步） ─────────────────────
  ipcMain.handle("agent:listTools", async (_, mode?: string) => {
    return (await sm.request("GET", `/api/tools${mode ? `?mode=${mode}` : ""}`)) as Array<{
      name: string
      description: string
      parameters: Record<string, unknown>
    }>
  })
  ipcMain.handle("agent:listAgents", async () => {
    return (await sm.request("GET", "/api/agents")) as Array<Record<string, unknown>>
  })
  ipcMain.handle("agent:executeTool", async (_, toolName: string, args: Record<string, unknown>) => {
    return (await sm.request("POST", "/api/agent/execute", { name: toolName, args })) as {
      success: boolean
      output?: string
      error?: string
    }
  })
  ipcMain.handle("agent:executeBatch", async (_, calls: Array<{ name: string; args: Record<string, unknown> }>) => {
    return (await sm.request("POST", "/api/agent/execute-batch", { calls })) as Array<{
      success: boolean
      output?: string
      error?: string
    }>
  })

  // ── 流式 Agent 执行（SSE 代理） ───────────────────
  ipcMain.handle("agent:startStream", async (event, sessionId: string, message: string, config: Record<string, unknown>) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) throw new Error("Cannot get sender window")
    console.log(`[Sidecar] startStream called, sm.running=${sm?.running}, port=${sm?.port}`)

    let streamChannel = ""
    let channel = ""

    const destroy = () => {
      sseSessions.delete(streamChannel)
      if (streamChannel) {
        sm.request("POST", "/api/agent/stop", { channel: streamChannel }).catch(() => {})
      }
    }

    channel = await connectAndGetChannel(
      sm,
      { sessionId, message, config },
      (data) => {
        if (!window.isDestroyed()) {
          window.webContents.send("agent:event", channel, data)
        }
      },
      () => {
        if (!window.isDestroyed() && channel) {
          window.webContents.send("agent:event", channel, { type: "finish", reason: "completed" })
        }
        sseSessions.delete(channel)
      },
      (err) => {
        console.error(`[Sidecar] Stream error: ${err.message}`)
        if (!window.isDestroyed() && channel) {
          window.webContents.send("agent:event", channel, { type: "error", message: err.message })
        }
        sseSessions.delete(channel)
      },
    )

    streamChannel = channel
    sseSessions.set(channel, { channel, destroy })

    return channel
  })

  // ── 权限回复 ──────────────────────────────────────
  ipcMain.handle("agent:replyPermission", async (_, channel: string, requestId: string, reply: string) => {
    return (await sm.request("POST", "/api/agent/permission-reply", { channel, requestId, reply })) as void
  })

  // ── 停止流 ────────────────────────────────────────
  ipcMain.handle("agent:stopStream", async (_, channel: string) => {
    const session = sseSessions.get(channel)
    if (session) {
      session.destroy()
      sseSessions.delete(channel)
    }
    return (await sm.request("POST", "/api/agent/stop", { channel })) as void
  })

  // ── LLM 生成追问建议 ─────────────────────────────
  ipcMain.handle("agent:suggestFollowUps", async (_, sessionId: string) => {
    return (await sm.request("POST", "/api/agent/follow-ups", { sessionId })) as { suggestions: string[] }
  })

  // ── 清理退出 ──────────────────────────────────────
  app.on("before-quit", () => {
    sseSessions.forEach((s) => s.destroy())
    sseSessions.clear()
  })
}
