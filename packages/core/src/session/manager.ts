import { loadSession, listSessions as sqliteListSessions } from "../session/store"
import { getDbAsync, runWrite, reloadDatabase } from "../system/database"
import { getPlatformPaths } from "../config/paths"
import { join } from "path"
import fs from "fs"

export interface SessionInfo {
  session_id: string
  project_id: string
  title: string
  kind: "session" | "task"
  workspace_path: string
  message_count: number
  updated_at: string
}

export interface ProjectInfo {
  project_id: string
  name: string
  workspace_path: string
}

/** 路径规范化：统一分隔符、去末尾斜杠、Windows 大小写不敏感 */
function normalizePath(p: string): string {
  const trimmed = (p || "").trim()
  if (!trimmed) return ""
  const unified = trimmed.replace(/[\\/]+$/, "").replace(/\\/g, "/")
  return process.platform === "win32" ? unified.toLowerCase() : unified
}

/** 项目去重锁：防止并发调用 createProject 导致重复插入 */
let createProjectLock: Promise<ProjectInfo> | null = null

export async function createProject(name: string, workspacePath: string): Promise<ProjectInfo> {
  // 如果已有正在进行的创建请求，等待其完成后再检查
  if (createProjectLock) {
    await createProjectLock
  }

  const doCreate = async (): Promise<ProjectInfo> => {
    const normalized = normalizePath(workspacePath)
    const projects = await listProjects()

    // 去重策略：1) 同路径复用 2) 同名复用（路径为空时）
    const existing = projects.find((p) => {
      const pNorm = normalizePath(p.workspace_path)
      if (normalized && pNorm) return pNorm === normalized
      // 路径为空时按名称去重
      if (!normalized && !pNorm) return p.name === name
      return false
    })
    if (existing) return existing

    const project_id = `proj_${Date.now().toString(36)}`
    await getDbAsync()
    runWrite(
      "INSERT INTO projects (project_id, name, workspace_path) VALUES (?, ?, ?)",
      [project_id, name, workspacePath],
    )
    return { project_id, name, workspace_path: workspacePath }
  }

  const promise = doCreate()
  createProjectLock = promise
  try {
    return await promise
  } finally {
    createProjectLock = null
  }
}

export async function listProjects(): Promise<ProjectInfo[]> {
  reloadDatabase()
  const db = await getDbAsync()
  const rows = db.exec("SELECT project_id, name, workspace_path FROM projects")
  if (rows.length === 0) return []
  return rows[0].values.map((row) => {
    const [project_id, name, workspace_path] = row as string[]
    return { project_id, name, workspace_path: workspace_path || "" }
  })
}

export async function createSession(projectId: string, title?: string): Promise<SessionInfo> {
  const sessionId = `ses_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const projects = await listProjects()
  const project = projects.find((p) => p.project_id === projectId)
  const workspace = project?.workspace_path || ""

  await getDbAsync()
  runWrite(
    "INSERT INTO sessions (session_id, project_id, title, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [sessionId, projectId, title || `新会话 ${new Date().toLocaleDateString("zh-CN")}`, workspace, now, now],
  )

  return { session_id: sessionId, project_id: projectId, title: title || "新会话", kind: "session", workspace_path: workspace, message_count: 0, updated_at: now }
}

export async function listSessions(projectId?: string): Promise<SessionInfo[]> {
  reloadDatabase()
  const db = await getDbAsync()
  const rows = db.exec(
    projectId
      ? "SELECT session_id, project_id, title, workspace, created_at, updated_at, COALESCE(cost,0), COALESCE(tokens_input,0), COALESCE(tokens_output,0), COALESCE(tokens_cache_read,0), COALESCE(tokens_cache_write,0) FROM sessions WHERE project_id = ? ORDER BY updated_at DESC"
      : "SELECT session_id, project_id, title, workspace, created_at, updated_at, COALESCE(cost,0), COALESCE(tokens_input,0), COALESCE(tokens_output,0), COALESCE(tokens_cache_read,0), COALESCE(tokens_cache_write,0) FROM sessions ORDER BY updated_at DESC",
    projectId ? [projectId] : [],
  )
  if (rows.length === 0) return []

  // 统计每个会话的消息数
  const countMap = new Map<string, number>()
  try {
    const countRows = db.exec(
      "SELECT session_id, COUNT(*) as cnt FROM messages GROUP BY session_id"
    )
    if (countRows.length > 0) {
      for (const row of countRows[0].values) {
        countMap.set(String(row[0]), Number(row[1]))
      }
    }
  } catch { /* messages 表可能不存在 */ }

  return rows[0].values.map((row) => {
    const [session_id, project_id, title, workspace, _created, updated_at, cost, tokensInput, tokensOutput, tokensCacheRead, tokensCacheWrite] = row as string[]
    return {
      session_id,
      project_id: project_id || projectId || "",
      title: title || "",
      kind: "session",
      workspace_path: workspace || "",
      message_count: countMap.get(session_id) || 0,
      updated_at: updated_at || "",
      cost: Number(cost) || 0,
      tokens: {
        input: Number(tokensInput) || 0,
        output: Number(tokensOutput) || 0,
        cacheRead: Number(tokensCacheRead) || 0,
        cacheWrite: Number(tokensCacheWrite) || 0,
      },
    }
  })
}

export async function getSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string; id: number; retryCount?: number; timestamp?: string }>> {
  reloadDatabase()
  const stored = await loadSession(sessionId)
  if (!stored) return []
  return stored.messages.map((m, i) => ({
    id: m.id ?? i,
    role: m.role,
    content: m.content,
    retryCount: m.retryCount || 0,
    timestamp: m.timestamp,
  }))
}

export async function updateProject(projectId: string, data: { name?: string; workspace_path?: string }): Promise<void> {
  const db = await getDbAsync()
  const updates: string[] = []
  const params: string[] = []
  if (data.name !== undefined) { updates.push("name = ?"); params.push(data.name) }
  if (data.workspace_path !== undefined) { updates.push("workspace_path = ?"); params.push(data.workspace_path) }
  if (updates.length === 0) return
  params.push(projectId)
  runWrite(`UPDATE projects SET ${updates.join(", ")} WHERE project_id = ?`, params)
}

export async function restoreSnapshot(snapshotId: string, workspace: string): Promise<string[]> {
  const { getSnapshotManager } = await import("./snapshot")
  const mgr = getSnapshotManager(workspace)
  return mgr.restore(snapshotId)
}

export async function updateSession(sessionId: string, data: { title?: string }): Promise<void> {
  const db = await getDbAsync()
  const updates: string[] = []
  const params: string[] = []
  if (data.title !== undefined) { updates.push("title = ?"); params.push(data.title) }
  if (updates.length === 0) return
  updates.push("updated_at = ?")
  params.push(new Date().toISOString())
  params.push(sessionId)
  runWrite(`UPDATE sessions SET ${updates.join(", ")} WHERE session_id = ?`, params)
}

/**
 * 累加会话成本/token 用量（参考 opencode Session.Info.cost/tokens 聚合）
 * 每次 LLM 调用完成后调用，把当次 cost/tokens 累加到 sessions 表
 */
export async function accumulateSessionUsage(
  sessionId: string,
  usage: { cost: number; inputTokens: number; outputTokens: number; reasoningTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): Promise<void> {
  try {
    const db = await getDbAsync()
    runWrite(
      `UPDATE sessions SET
        cost = COALESCE(cost, 0) + ?,
        tokens_input = COALESCE(tokens_input, 0) + ?,
        tokens_output = COALESCE(tokens_output, 0) + ?,
        tokens_reasoning = COALESCE(tokens_reasoning, 0) + ?,
        tokens_cache_read = COALESCE(tokens_cache_read, 0) + ?,
        tokens_cache_write = COALESCE(tokens_cache_write, 0) + ?,
        updated_at = ?
       WHERE session_id = ?`,
      [
        usage.cost || 0,
        usage.inputTokens || 0,
        usage.outputTokens || 0,
        usage.reasoningTokens || 0,
        usage.cacheReadTokens || 0,
        usage.cacheWriteTokens || 0,
        new Date().toISOString(),
        sessionId,
      ],
    )
  } catch { /* 成本累加失败不阻塞主流程 */ }
}

/** 获取会话的成本/token 汇总 */
export async function getSessionUsage(sessionId: string): Promise<{
  cost: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cacheReadTokens: number; cacheWriteTokens: number
} | null> {
  try {
    const db = await getDbAsync()
    const result = db.exec(
      "SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM sessions WHERE session_id = ?",
      [sessionId],
    )
    if (result.length === 0 || result[0].values.length === 0) return null
    const row = result[0].values[0]
    return {
      cost: Number(row[0]) || 0,
      inputTokens: Number(row[1]) || 0,
      outputTokens: Number(row[2]) || 0,
      reasoningTokens: Number(row[3]) || 0,
      cacheReadTokens: Number(row[4]) || 0,
      cacheWriteTokens: Number(row[5]) || 0,
    }
  } catch {
    return null
  }
}

/** 删除单条消息（UI 重试/编辑历史消息时清理旧记录） */
export async function deleteMessageById(sessionId: string, messageId: number): Promise<void> {
  const { deleteMessage } = await import("./store")
  await deleteMessage(sessionId, messageId)
}

export async function deleteProjectById(projectId: string): Promise<void> {
  const db = await getDbAsync()
  runWrite("DELETE FROM messages WHERE session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)", [projectId])
  runWrite("DELETE FROM sessions WHERE project_id = ?", [projectId])
  runWrite("DELETE FROM projects WHERE project_id = ?", [projectId])
}

export async function searchMessages(query: string): Promise<Array<{ session_id: string; session_title: string; message: { role: string; content: string; timestamp: string }; context: string }>> {
  if (!query.trim()) return []
  const db = await getDbAsync()

  // 优先使用 FTS5 全文搜索
  try {
    const ftsResult = db.exec(
      `SELECT fts.session_id, fts.role, fts.content, s.title
       FROM messages_fts fts
       JOIN sessions s ON s.session_id = fts.session_id
       WHERE messages_fts MATCH ?
       ORDER BY rank LIMIT 50`,
      [query],
    )
    if (ftsResult.length > 0 && ftsResult[0].values.length > 0) {
      return ftsResult[0].values.map(row => ({
        session_id: row[0] as string,
        session_title: row[3] as string,
        message: { role: row[1] as string, content: (row[2] as string).slice(0, 300), timestamp: "" },
        context: (row[2] as string).slice(0, 100),
      }))
    }
  } catch { /* FTS5 不可用，回退到 LIKE */ }

  // LIKE 回退
  const q = query.toLowerCase()
  const allSessions = await sqliteListSessions()
  const results: Array<{ session_id: string; session_title: string; message: { role: string; content: string; timestamp: string }; context: string }> = []

  for (const s of allSessions) {
    for (const msg of s.messages) {
      if (msg.content.toLowerCase().includes(q)) {
        const idx = s.messages.indexOf(msg)
        const prev = idx > 0 ? s.messages[idx - 1].content.slice(0, 100) : ""
        const next = idx < s.messages.length - 1 ? s.messages[idx + 1].content.slice(0, 100) : ""
        results.push({
          session_id: s.id,
          session_title: s.title,
          message: { role: msg.role, content: msg.content.slice(0, 300), timestamp: msg.timestamp },
          context: `…${prev} → ${msg.content.slice(0, 100)} → ${next}…`,
        })
        if (results.length >= 50) return results
      }
    }
  }
  return results
}

/** 清理单个会话关联的记忆/检查点文件（失败不阻塞主流程） */
function cleanupSessionMemoryFiles(sessionId: string): void {
  try {
    const baseDir = getPlatformPaths().userData
    // 清理 BuiltinMemoryProvider JSON
    const memoryPath = join(baseDir, "memory", `${sessionId}.json`)
    if (fs.existsSync(memoryPath)) fs.unlinkSync(memoryPath)
    // 清理 VectorMemoryProvider JSON
    const vectorPath = join(baseDir, "vector-memory", `${sessionId}.json`)
    if (fs.existsSync(vectorPath)) fs.unlinkSync(vectorPath)
    // 清理 CheckpointProvider 目录
    const checkpointDir = join(baseDir, "checkpoints", sessionId)
    if (fs.existsSync(checkpointDir)) fs.rmSync(checkpointDir, { recursive: true, force: true })
  } catch { /* 文件清理失败不阻塞主流程 */ }
}

/** 清理 FTS 记忆索引（共享文件，一次打开批量删除指定会话） */
async function cleanupFTSMemoryIndex(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  try {
    const sqlModule = await import("sql.js")
    const _SQL = await sqlModule.default()
    const ftsPath = join(getPlatformPaths().userData, "fts-memory.db")
    if (!fs.existsSync(ftsPath)) return
    const buffer = fs.readFileSync(ftsPath)
    const ftsDb = new _SQL.Database(buffer)
    for (const sessionId of sessionIds) {
      ftsDb.run("DELETE FROM fts_memory WHERE session_id = ?", [sessionId])
      ftsDb.run("DELETE FROM fts_memory_fts WHERE session_id = ?", [sessionId])
    }
    fs.writeFileSync(ftsPath, Buffer.from(ftsDb.export()))
    ftsDb.close()
  } catch { /* FTS 清理失败不阻塞 */ }
}

export async function deleteSessionById(sessionId: string): Promise<void> {
  const db = await getDbAsync()
  runWrite("DELETE FROM messages WHERE session_id = ?", [sessionId])
  runWrite("DELETE FROM sessions WHERE session_id = ?", [sessionId])
  cleanupSessionMemoryFiles(sessionId)
  await cleanupFTSMemoryIndex([sessionId])
}

/** 批量删除会话（单次 SQL 批量 + 逐会话清理记忆文件） */
export async function deleteSessionsById(sessionIds: string[]): Promise<void> {
  const ids = Array.from(new Set(sessionIds.filter(Boolean)))
  if (ids.length === 0) return
  const db = await getDbAsync()
  const placeholders = ids.map(() => "?").join(", ")
  runWrite(`DELETE FROM messages WHERE session_id IN (${placeholders})`, ids)
  runWrite(`DELETE FROM sessions WHERE session_id IN (${placeholders})`, ids)
  for (const id of ids) cleanupSessionMemoryFiles(id)
  await cleanupFTSMemoryIndex(ids)
}
