/**
 * Sidecar HTTP Server — 使用 Node.js 内置 http 模块
 * 将 @mira/core 暴露为 HTTP API，使 Electron 只做壳
 */

import * as http from "http"
import * as url from "url"
import * as crypto from "crypto"
import * as fs from "fs"
import * as pathLib from "path"
import { getPlatformPaths } from "../../config/paths"

import {
  handleStartStream,
  handlePermissionReply,
  handleStopStream,
  handleListTools,
  handleListAgents,
  handleExecuteTool,
  handleExecuteBatch,
  handleMemorySearch,
  handleMemorySearchByProject,
  handleMemoryStatus,
  handleGetGraphData,
  handleFollowUps,
  handleListProjects,
  handleCreateProject,
  handleUpdateProject,
  handleDeleteProject,
  handleCreateSession,
  handleListSessions,
  handleGetSessionMessages,
  handleDeleteSession,
  handleDeleteSessions,
  handleDeleteMessage,
  handleSearchMessages,
  handleUpdateSession,
  handleRestoreSnapshot,
  handleSubagentSpawn,
  handleSubagentWait,
  handleSubagentCancel,
  handleSubagentGet,
  handleSubagentList,
  handleSubagentListActive,
  handleSubagentListByParent,
  handleSubagentCancelByParent,
  handleSubagentCancelAll,
  handleSubagentToText,
  handleGoalSet,
  handleGoalGetActive,
  handleGoalList,
  handleGoalCancel,
  handleGoalToText,
  handleGoalLoad,
  handleGoalSave,
  handleTaskCreate,
  handleTaskUpdateStatus,
  handleTaskUpdateSummary,
  handleTaskAddNote,
  handleTaskGet,
  handleTaskList,
  handleTaskListActive,
  handleTaskToText,
  handleQuestionAnswer,
  handleQuestionListPending,
  handleRunGraphTask,
  handleGraphGetStatus,
  handleGraphListRuns,
  handleGraphStop,
  handleSelfmodListPlugins,
  handleSelfmodGetClientCode,
  handleSelfmodStatus,
  type APIContext,
} from "./api"
import type { PermissionReply } from "../../index"

export interface ServerOptions {
  port: number
  host?: string
  authToken?: string
}

/** 解析 JSON body */
function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8")
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error("Invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}

/** Sidecar API 请求体（POST 接口共用字段，全部可选） */
interface RequestBody {
  name?: string
  args?: Record<string, unknown>
  calls?: Array<{ name: string; args: Record<string, unknown> }>
  sessionId?: string
  sessionIds?: string[]
  message?: string
  config?: Record<string, unknown>
  channel?: string
  requestId?: string
  reply?: PermissionReply
  query?: string
  type?: string
  limit?: number
  projectId?: string
  workspace?: string
  data?: Record<string, unknown>
  messageId?: number
  snapshotId?: string
  title?: string
  description?: string
  parentId?: string
  model?: string
  status?: string
  summary?: string
  note?: string
  taskId?: string
  request?: string
  testCommand?: string
  maxSteps?: number
  maxTotalTokens?: number
  graphId?: string
  questionId?: string
  answer?: string
  filter?: Record<string, unknown>
  id?: string
  prompt?: string
  timeoutMs?: number
  runId?: string
}

/** 验证 auth token */
function checkAuth(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true
  const auth = req.headers["authorization"]
  return auth === `Bearer ${token}`
}

/** 写 JSON 响应 */
function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

/** 写错误响应 */
function errorResponse(res: http.ServerResponse, status: number, message: string): void {
  jsonResponse(res, status, { error: message })
}

export function createServer(options: ServerOptions): http.Server {
  const { port, host = "127.0.0.1", authToken } = options

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    if (!checkAuth(req, authToken)) {
      errorResponse(res, 401, "Unauthorized")
      return
    }

    const parsedUrl = url.parse(req.url || "", true)
    const path = parsedUrl.pathname

    try {
      await routeRequest(req, res, path, parsedUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Sidecar] Error: ${message}`)
      errorResponse(res, 500, message || "Internal server error")
    }
  })

  // 延长空闲 keep-alive 关闭阈值（Node 默认 5s）：主进程每次请求都是新连接，
  // 避免已建立的空闲连接被过早关闭而引发竞态；headersTimeout 需大于 keepAliveTimeout
  server.keepAliveTimeout = 60_000
  server.headersTimeout = 65_000
  server.requestTimeout = 300_000

  return server
}

async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string | null,
  parsedUrl: url.UrlWithParsedQuery,
): Promise<void> {
  const query = parsedUrl.query

  switch (path) {
    // ── Health ──
    case "/api/health": {
      jsonResponse(res, 200, { status: "ok", timestamp: Date.now() })
      return
    }

    // ── List tools ──
    case "/api/tools": {
      const tools = handleListTools(query.mode as string)
      jsonResponse(res, 200, tools)
      return
    }

    // ── List agents ──
    case "/api/agents": {
      const agents = handleListAgents()
      jsonResponse(res, 200, agents)
      return
    }

    // ── Execute single tool ──
    case "/api/agent/execute": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      const result = await handleExecuteTool(body.name as string, body.args || {})
      jsonResponse(res, 200, result)
      return
    }

    // ── Execute batch tools ──
    case "/api/agent/execute-batch": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      const results = await handleExecuteBatch(body.calls || [])
      jsonResponse(res, 200, results)
      return
    }

    // ── Start streaming agent (SSE) ──
    case "/api/agent/stream": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody

      const sessionId = body.sessionId
      const message = body.message
      const config = body.config || {}

      if (!sessionId || !message) {
        errorResponse(res, 400, `sessionId and message are required (got sessionId=${JSON.stringify(sessionId)}, message length=${(message || "").length})`)
        return
      }

      const channel = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

      // 立即发送 SSE headers + channel 事件，不等待 Agent 初始化
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      })
      // 连接确认事件，客户端可区分"未连接"vs"正常空转"
      res.write(`event: connected\ndata: {"status":"ok"}\n\n`)
      res.write(`event: channel\ndata: ${JSON.stringify({ channel })}\n\n`)

      // 15 秒心跳 — 防止代理/防火墙/中间层断开空闲的 SSE 连接
      const heartbeat = setInterval(() => {
        try {
          res.write(": heartbeat\n\n")
        } catch {
          clearInterval(heartbeat)
        }
      }, 15000)
      req.on("close", () => clearInterval(heartbeat))

      const ctx: APIContext = {
        writeEvent: (data: unknown) => {
          const id = crypto.randomUUID()
          res.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`)
        },
        writeEnd: () => {
          res.write("event: done\ndata: {}\n\n")
          res.end()
        },
        onAbort: (callback: () => void) => {
          req.on("close", callback)
        },
      }

      // 后台初始化 Agent，不阻塞 SSE 通道建立
      handleStartStream(sessionId, message, config, ctx, channel).catch((err) => {
        try { res.write(`event: error\ndata: ${JSON.stringify({ type: "error", message: String(err) })}\n\n`) } catch { /* 忽略写入失败 */ }
      })
      return
    }

    // ── Reply permission ──
    case "/api/agent/permission-reply": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      const ok = handlePermissionReply(body.channel as string, body.requestId as string, body.reply as PermissionReply)
      if (!ok) {
        errorResponse(res, 404, "Session not found")
        return
      }
      jsonResponse(res, 200, { ok: true })
      return
    }

    // ── Stop stream ──
    case "/api/agent/stop": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      const ok = handleStopStream(body.channel as string)
      if (!ok) {
        errorResponse(res, 404, "Session not found")
        return
      }
      jsonResponse(res, 200, { ok: true })
      return
    }

    // ── Memory search ──
    case "/api/memory/search": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      const result = await handleMemorySearch(body.query as string, body.type, body.limit)
      jsonResponse(res, 200, result)
      return
    }

    // ── Memory search by project ──
    case "/api/memory/search-by-project": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      const result = await handleMemorySearchByProject(body.query as string, body.projectId as string, body.limit)
      jsonResponse(res, 200, result)
      return
    }

    // ── Graph data from Dream ──
    case "/api/memory/graph": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      const result = await handleGetGraphData()
      jsonResponse(res, 200, result)
      return
    }

    // ── Memory status ──
    case "/api/memory/status": {
      const status = handleMemoryStatus()
      jsonResponse(res, 200, status)
      return
    }

    // ── Self-modification status ──
    case "/api/selfmod/status": {
      jsonResponse(res, 200, handleSelfmodStatus())
      return
    }

    // ── Self-modification: list session plugins ──
    case "/api/selfmod/plugins": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, handleSelfmodListPlugins(body as { sessionId?: string }))
      return
    }

    // ── Self-modification: get plugin client half code ──
    case "/api/selfmod/plugin/client": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, handleSelfmodGetClientCode(body as { sessionId?: string; pluginId?: string; packageId?: string }))
      return
    }

    // ── Follow-up suggestions (LLM 生成追问) ──
    case "/api/agent/follow-ups": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      if (!body.sessionId) {
        errorResponse(res, 400, "sessionId is required")
        return
      }
      const result = await handleFollowUps(body.sessionId)
      jsonResponse(res, 200, result)
      return
    }

    // ── 项目 CRUD（Sidecar 单写者） ──
    case "/api/projects": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, await handleListProjects())
      return
    }
    case "/api/project/create": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, await handleCreateProject(body.name as string, body.workspace as string))
      return
    }
    case "/api/project/update": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      await handleUpdateProject(body.projectId as string, body.data || {})
      jsonResponse(res, 200, { ok: true })
      return
    }
    case "/api/project/delete": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      await handleDeleteProject(body.projectId as string)
      jsonResponse(res, 200, { ok: true })
      return
    }

    // ── 会话 CRUD（Sidecar 单写者） ──
    case "/api/session/create": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, await handleCreateSession(body.projectId as string, body.title))
      return
    }
    case "/api/sessions": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, await handleListSessions(query.projectId as string))
      return
    }
    case "/api/session/messages": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      if (!query.sessionId) {
        errorResponse(res, 400, "sessionId is required")
        return
      }
      jsonResponse(res, 200, await handleGetSessionMessages(query.sessionId as string))
      return
    }
    case "/api/session/delete": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      await handleDeleteSession(body.sessionId as string)
      jsonResponse(res, 200, { ok: true })
      return
    }
    case "/api/session/delete-many": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      await handleDeleteSessions((body.sessionIds as string[]) || [])
      jsonResponse(res, 200, { ok: true })
      return
    }
    case "/api/message/delete": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      await handleDeleteMessage(body.sessionId as string, body.messageId as number)
      jsonResponse(res, 200, { ok: true })
      return
    }
    case "/api/session/search": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, await handleSearchMessages(body.query as string))
      return
    }
    // 读取会话附件（历史恢复：路径 → base64 data URL）
    case "/api/attachment": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      const relPath = query.path as string | undefined
      if (!relPath) { errorResponse(res, 400, "path is required"); return }
      // 安全校验：relPath 形如 "attachments/{sessionId}/{file}"，仅允许访问 attachments 目录
      const base = pathLib.resolve(getPlatformPaths().userData)
      const abs = pathLib.resolve(base, relPath)
      const attachmentsDir = pathLib.join(base, "attachments")
      if (!abs.startsWith(attachmentsDir + pathLib.sep)) { errorResponse(res, 403, "Invalid attachment path"); return }
      try {
        const data = await fs.promises.readFile(abs)
        const ext = pathLib.extname(abs).slice(1).toLowerCase()
        const mime = ext === "pdf" ? "application/pdf"
          : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "gif" ? "image/gif"
          : ext === "webp" ? "image/webp"
          : "image/png"
        jsonResponse(res, 200, { data: `data:${mime};base64,${data.toString("base64")}` })
      } catch {
        errorResponse(res, 404, "Attachment not found")
      }
      return
    }
    case "/api/session/update": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      await handleUpdateSession(body.sessionId as string, body.data || {})
      jsonResponse(res, 200, { ok: true })
      return
    }
    case "/api/session/restore-snapshot": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      await handleRestoreSnapshot(body.snapshotId as string, body.workspace as string)
      jsonResponse(res, 200, { ok: true })
      return
    }

    // ── 子 Agent（Sidecar 单写者） ──
    case "/api/subagent/spawn": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, handleSubagentSpawn(body.description as string, body.config || {}, {
        parentId: body.parentId, prompt: body.prompt, model: body.model,
      }))
      return
    }
    case "/api/subagent/wait": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, await handleSubagentWait(body.id as string, body.timeoutMs))
      return
    }
    case "/api/subagent/cancel": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, { ok: handleSubagentCancel(body.id as string) })
      return
    }
    case "/api/subagent/get": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleSubagentGet(query.id as string))
      return
    }
    case "/api/subagent/list": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, handleSubagentList(body.filter))
      return
    }
    case "/api/subagent/listActive": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleSubagentListActive())
      return
    }
    case "/api/subagent/listByParent": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleSubagentListByParent(query.parentId as string))
      return
    }
    case "/api/subagent/cancelByParent": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, { ok: handleSubagentCancelByParent(body.parentId as string) })
      return
    }
    case "/api/subagent/cancelAll": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, { ok: handleSubagentCancelAll() })
      return
    }
    case "/api/subagent/toText": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, { text: handleSubagentToText() })
      return
    }

    // ── Goal（Sidecar 单写者） ──
    case "/api/goal/set": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, handleGoalSet(body.description as string, body.timeoutMs))
      return
    }
    case "/api/goal/getActive": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleGoalGetActive())
      return
    }
    case "/api/goal/list": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleGoalList())
      return
    }
    case "/api/goal/cancel": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, { ok: handleGoalCancel() })
      return
    }
    case "/api/goal/toText": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, { text: handleGoalToText() })
      return
    }
    case "/api/goal/load": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, await handleGoalLoad(body.sessionId as string))
      return
    }
    case "/api/goal/save": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      await handleGoalSave()
      jsonResponse(res, 200, { ok: true })
      return
    }

    // ── Task（Sidecar 单写者） ──
    case "/api/task/create": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, handleTaskCreate(body.summary as string, body.parentId))
      return
    }
    case "/api/task/updateStatus": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, { ok: handleTaskUpdateStatus(body.taskId as string, body.status as string) })
      return
    }
    case "/api/task/updateSummary": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, { ok: handleTaskUpdateSummary(body.taskId as string, body.summary as string) })
      return
    }
    case "/api/task/addNote": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, { ok: handleTaskAddNote(body.taskId as string, body.note as string) })
      return
    }
    case "/api/task/get": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleTaskGet(query.taskId as string))
      return
    }
    case "/api/task/list": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleTaskList(query.status as string))
      return
    }
    case "/api/task/listActive": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleTaskListActive())
      return
    }
    case "/api/task/toText": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, { text: handleTaskToText() })
      return
    }

    // ── Question（Sidecar 单写者） ──
    case "/api/question/answer": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, { ok: handleQuestionAnswer(body.questionId as string, body.answer as string) })
      return
    }
    case "/api/question/pending": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleQuestionListPending())
      return
    }

    // ── Graph 图编排（Sidecar 单写者） ──
    case "/api/graph/run": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      const request = body.request as string
      const config = body.config || {}
      if (!request) {
        errorResponse(res, 400, "request is required")
        return
      }

      const runId = `graph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      })
      res.write(`event: connected\ndata: {"status":"ok"}\n\n`)
      res.write(`event: channel\ndata: ${JSON.stringify({ channel: runId })}\n\n`)

      const heartbeat = setInterval(() => {
        try { res.write(": heartbeat\n\n") } catch { clearInterval(heartbeat) }
      }, 15000)
      req.on("close", () => clearInterval(heartbeat))

      const ctx: APIContext = {
        writeEvent: (data: unknown) => {
          try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch { /* ignore */ }
        },
        writeEnd: () => {
          try { res.write("event: done\ndata: {}\n\n"); res.end() } catch { /* ignore */ }
        },
        onAbort: (callback: () => void) => { req.on("close", callback) },
      }

      handleRunGraphTask(request, config, {
        maxSteps: body.maxSteps,
        testCommand: body.testCommand,
        maxTotalTokens: body.maxTotalTokens,
      }, ctx, runId)
      return
    }
    case "/api/graph/status": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleGraphGetStatus(query.runId as string))
      return
    }
    case "/api/graph/listRuns": {
      if (req.method !== "GET") { errorResponse(res, 405, "Method not allowed"); return }
      jsonResponse(res, 200, handleGraphListRuns(query.graphId as string))
      return
    }
    case "/api/graph/stop": {
      if (req.method !== "POST") { errorResponse(res, 405, "Method not allowed"); return }
      const body = await parseBody(req) as RequestBody
      jsonResponse(res, 200, { ok: handleGraphStop(body.runId as string) })
      return
    }

    default:
      errorResponse(res, 404, `Not found: ${path}`)
  }
}

/** 启动服务器 */
export function startServer(options: ServerOptions): Promise<{ server: http.Server; port: number; token: string }> {
  return new Promise((resolve, reject) => {
    const token = options.authToken || crypto.randomBytes(32).toString("hex")
    const server = createServer({ ...options, authToken: token })

    server.listen(options.port, options.host || "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : options.port
      console.log(`[Sidecar] Server running on http://127.0.0.1:${port}`)
      resolve({ server, port, token })
    })

    server.on("error", reject)
  })
}
