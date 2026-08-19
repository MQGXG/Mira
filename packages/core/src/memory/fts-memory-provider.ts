/**
 * FTS5 全文搜索 Memory Provider — 使用真 FTS5 + BM25
 * 参考 MiMo-Code memory/service.ts
 * 
 * 改动：普通表 → FTS5 虚拟表，LIKE → MATCH，LENGTH → rank(BM25)
 */

import type { MemoryProvider } from "./types"
import initSqlJs, { type Database as SqliteDb } from "sql.js"
import { getPlatformPaths } from "../config/paths"
import { join } from "path"
import * as fss from "fs"
import * as fsp from "fs/promises"
import * as pt from "path"
import { getDbAsync } from "../system/database"

const DEFAULT_IGNORE_DIRS = ["node_modules", ".git", ".svn", ".hg", "target", "dist", "build", ".next", ".nuxt", "venv", "__pycache__", ".cache", ".idea", ".vscode", ".mimo", ".opencode"]
const DEFAULT_IGNORE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff", ".woff2", ".eot", ".ttf", ".otf", ".pyc", ".class", ".o", ".so", ".dll", ".exe", ".zip", ".tar", ".gz"]
const DEFAULT_MAX_FILE_SIZE = 100 * 1024
const DEFAULT_MAX_RESULTS = 5
const DEFAULT_SCORE_FLOOR = 0.15
const DEFAULT_RECONCILE_INTERVAL = 5 * 60 * 1000
const DEFAULT_SAVE_INTERVAL = 60 * 1000

export interface FTSMemoryOptions {
  ignoreDirs?: string[]
  ignoreExts?: string[]
  maxFileSize?: number
  maxResults?: number
  scoreFloor?: number
  reconcileInterval?: number
  saveInterval?: number
}

export class FTSMemoryProvider implements MemoryProvider {
  name = "fts-memory"
  private workspace = ""
  private db: SqliteDb | null = null
  private SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
  private ready = false

  private ignoreDirs: Set<string>
  private ignoreExts: Set<string>
  private maxFileSize: number
  private maxResults: number
  private scoreFloor: number
  private reconcileInterval: number
  private saveInterval: number

  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private saveTimer: ReturnType<typeof setInterval> | null = null
  private reconciling = false
  private fileMtimes = new Map<string, number>()
  private _hasFTS5 = false
  /** tokenize='unicode61' 的查询转义：FTS5 特殊字符 */
  private static readonly FTS5_SPECIAL = /['"*()^${}~:+-]/g

  constructor(opts?: FTSMemoryOptions) {
    this.ignoreDirs = new Set(opts?.ignoreDirs || DEFAULT_IGNORE_DIRS)
    this.ignoreExts = new Set(opts?.ignoreExts || DEFAULT_IGNORE_EXTS)
    this.maxFileSize = opts?.maxFileSize || DEFAULT_MAX_FILE_SIZE
    this.maxResults = opts?.maxResults || DEFAULT_MAX_RESULTS
    this.scoreFloor = opts?.scoreFloor ?? DEFAULT_SCORE_FLOOR
    this.reconcileInterval = opts?.reconcileInterval ?? DEFAULT_RECONCILE_INTERVAL
    this.saveInterval = opts?.saveInterval ?? DEFAULT_SAVE_INTERVAL
  }

  private dbPath(): string {
    return join(getPlatformPaths().userData, "fts-memory.db")
  }

  /** 转义 FTS5 查询关键字中的特殊字符 */
  private static escapeFTS5(text: string): string {
    return text.replace(FTSMemoryProvider.FTS5_SPECIAL, " ")
  }

  /** 将查询文本转为 FTS5 MATCH 表达式：空格分词 + 隐式 AND */
  private static toFTS5Query(text: string): string {
    const tokens = text.match(/[\p{L}\p{N}_]+/gu)
    if (!tokens || tokens.length === 0) return ""
    return tokens
      .map(t => FTSMemoryProvider.escapeFTS5(t.toLowerCase()))
      .filter(Boolean)
      .join(" AND ")
  }

  async initialize(_sessionID: string, workspace: string): Promise<void> {
    if (this.ready) return
    this.workspace = workspace
    this.SQL = await initSqlJs()
    const dbPath = this.dbPath()
    if (dbPath) {
      try {
        // 异步读取大库文件，避免同步 I/O 阻塞 Sidecar 事件循环（fts-memory.db 可达 GB 级）
        const buffer = await fsp.readFile(dbPath)
        this.db = new this.SQL.Database(buffer)
      } catch { /* 新数据库 */ }
    }
    if (!this.db) this.db = new this.SQL.Database()

    // 尝试创建 FTS5 虚拟表，失败则回退到普通表 + LIKE
    try {
      this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
        path UNINDEXED,
        content,
        filetype UNINDEXED,
        tokenize='unicode61'
      )`)
      this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_memory_fts USING fts5(
        content,
        session_id UNINDEXED,
        source UNINDEXED,
        tokenize='unicode61'
      )`)
      this._hasFTS5 = true
    } catch {
      // FTS5 不可用（sql.js 标准 WASM 不包含此扩展），使用普通表 + LIKE
      this._hasFTS5 = false
      this.db.run(`CREATE TABLE IF NOT EXISTS fts_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, content TEXT, filetype TEXT
      )`)
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS fts_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, content TEXT, session_id TEXT
    )`)

    // 升级旧版 fts_memory_fts（缺少 session_id/source 列）：重建并重新索引
    if (this._hasFTS5) {
      try {
        this.db.exec("SELECT session_id FROM fts_memory_fts LIMIT 0")
      } catch {
        try {
          this.db.run("DROP TABLE IF EXISTS fts_memory_fts")
          this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_memory_fts USING fts5(
            content, session_id UNINDEXED, source UNINDEXED, tokenize='unicode61'
          )`)
          const rows = this.db.exec("SELECT content, session_id, source FROM fts_memory")
          if (rows.length > 0 && rows[0].values) {
            for (const row of rows[0].values) {
              this.db.run("INSERT INTO fts_memory_fts (content, session_id, source) VALUES (?, ?, ?)", row)
            }
          }
        } catch { /* 迁移失败则降级为 LIKE 搜索 */ }
      }
    }

    if (this.reconcileInterval > 0) {
      this.reconcileTimer = setInterval(() => this.reconcile(), this.reconcileInterval)
    }
    if (this.saveInterval > 0) {
      this.saveTimer = setInterval(() => this.save(), this.saveInterval)
    }

    this.ready = true
  }

  buildSystemPrompt(): string {
    const mode = this._hasFTS5 ? "FTS5 全文搜索" : "关键词搜索"
    return `[Memory: ${mode}索引可用，Agent 可主动调用 memory_search 工具]`
  }

  async prefetch(query: string, _sessionID: string): Promise<string> {
    if (!this.ready) return ""
    try {
      return await this.search(query)
    } catch { return "" }
  }

  async syncTurn(_user: string, _assistant: string, _sessionID: string): Promise<void> {
    // FTS 不需要逐轮同步
  }

  async shutdown(): Promise<void> {
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null }
    if (this.saveTimer) { clearInterval(this.saveTimer); this.saveTimer = null }
    this.save()
    if (this.db) { this.db.close(); this.db = null }
    this.ready = false
  }

  /** 索引重建 — 全量扫描 + 增量更新 */
  async reconcile(): Promise<{ indexed: number; pruned: number }> {
    if (!this.db || this.reconciling) return { indexed: 0, pruned: 0 }
    this.reconciling = true
    try {
      const files = await this.scanFiles(this.workspace)
      let indexed = 0
      let pruned = 0

      const existing = this.db.exec(this._hasFTS5 ? "SELECT path FROM fts_files" : "SELECT path FROM fts_files")
      const indexedPaths = new Set(existing[0]?.values?.map((r) => r[0]) || [])

      // 清理已删除文件
      for (const p of indexedPaths) {
        if (!files.some((f) => f.path === p)) {
          this.db.run("DELETE FROM fts_files WHERE path = ?", [p])
          pruned++
        }
      }

      // 增量更新
      for (const file of files) {
        try {
          const stat = await fsp.stat(file.path)
          const lastMtime = this.fileMtimes.get(file.path)
          if (lastMtime === stat.mtimeMs && indexedPaths.has(file.path)) continue

          const content = await fsp.readFile(file.path, "utf-8")
          if (this._hasFTS5) {
            // FTS5 表不支持 UPDATE，使用 DELETE + INSERT 实现 upsert
            this.db.run("DELETE FROM fts_files WHERE path = ?", [file.path])
            this.db.run("INSERT INTO fts_files (path, content, filetype) VALUES (?, ?, ?)",
              [file.path, content, file.filetype])
          } else {
            this.db.run("INSERT OR REPLACE INTO fts_files (path, content, filetype) VALUES (?, ?, ?)",
              [file.path, content, file.filetype])
          }
          this.fileMtimes.set(file.path, stat.mtimeMs)
          indexed++
        } catch { /* 跳过 */ }
      }

      this.save()
      return { indexed, pruned }
    } finally {
      this.reconciling = false
    }
  }

  /** 全文搜索 — FTS5 优先，回退到 LIKE */
  async search(query: string): Promise<string> {
    if (!this.db) return ""
    if (this._hasFTS5) return this.searchFTS5(query)
    return this.searchLikeFallback(query)
  }

  /** FTS5 全文搜索 — BM25 排序 + snippet 高亮 */
  private async searchFTS5(query: string): Promise<string> {
    if (!this.db) return ""
    const ftsQuery = FTSMemoryProvider.toFTS5Query(query)
    if (!ftsQuery) return ""

    try {
      const stmt = this.db.prepare(`
        SELECT path, snippet(fts_files, 1, '<b>', '</b>', '...', 48) AS snippet, rank
        FROM fts_files
        WHERE fts_files MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      stmt.bind([ftsQuery, this.maxResults])

      const results: Array<{ path: string; snippet: string; score: number }> = []
      while (stmt.step()) {
        const row = stmt.getAsObject() as any
        if (row.path) {
          results.push({
            path: row.path,
            snippet: String(row.snippet || "").replace(/<[^>]+>/g, "**"),
            score: row.rank !== undefined ? 1 / (1 + Number(row.rank)) : 0,
          })
        }
      }
      stmt.free()

      if (results.length === 0) return ""
      return `[相关文件记忆]\n${results.map((r) =>
        `文件: ${pt.relative(this.workspace, r.path)}\n片段: ${r.snippet}`
      ).join("\n\n")}`
    } catch {
      return this.searchLikeFallback(query)
    }
  }

  /** LIKE 回退 — 当 FTS5 查询失败时使用 */
  private async searchLikeFallback(query: string): Promise<string> {
    if (!this.db) return ""
    const tokens = query.match(/[\p{L}\p{N}_]+/gu)
    if (!tokens || tokens.length === 0) return ""

    try {
      const conditions = tokens.map(() => `content LIKE ?`).join(" AND ")
      const params = tokens.map(t => `%${t}%`)
      const stmt = this.db.prepare(`
        SELECT path, content FROM fts_files
        WHERE ${conditions}
        LIMIT ?
      `)
      stmt.bind([...params, this.maxResults])

      const results: Array<{ path: string; snippet: string }> = []
      while (stmt.step()) {
        const row = stmt.getAsObject() as any
        if (row.path) {
          const content = String(row.content || "")
          const idx = content.toLowerCase().indexOf(tokens[0].toLowerCase())
          const start = Math.max(0, idx - 40)
          const snippet = (start > 0 ? "..." : "") + content.slice(start, start + 80) + (start + 80 < content.length ? "..." : "")
          results.push({ path: row.path, snippet })
        }
      }
      stmt.free()

      if (results.length === 0) return ""
      return `[相关记忆]\n${results.map((r) =>
        `文件: ${pt.relative(this.workspace, r.path)}\n片段: ${r.snippet}`
      ).join("\n\n")}`
    } catch { return "" }
  }

  /** 索引 checkpoint 摘要到记忆表（有 FTS5 时同步索引） */
  indexCheckpoint(summary: string, sessionID: string): void {
    if (!this.db || !summary) return
    try {
      this.db.run(
        "INSERT INTO fts_memory (source, content, session_id) VALUES (?, ?, ?)",
        ["checkpoint", summary.slice(0, 1000), sessionID],
      )
      if (this._hasFTS5) {
        this.db.run("INSERT INTO fts_memory_fts (content, session_id, source) VALUES (?, ?, ?)",
          [summary.slice(0, 1000), sessionID, "checkpoint"])
      }
    } catch { /* 跳过 */ }
  }

  /**
   * 写入一条记忆（供会话记忆自动提取等场景）。
   * source 标记来源，默认 `inferred`（可在无需改动人工记忆的情况下批量回退）。
   */
  remember(content: string, sessionID: string, source = "inferred"): void {
    if (!this.db || !content) return
    try {
      const capped = content.slice(0, 500)
      this.db.run(
        "INSERT INTO fts_memory (source, content, session_id) VALUES (?, ?, ?)",
        [source, capped, sessionID],
      )
      if (this._hasFTS5) {
        this.db.run("INSERT INTO fts_memory_fts (content, session_id, source) VALUES (?, ?, ?)",
          [capped, sessionID, source])
      }
    } catch { /* 跳过 */ }
  }

  /** 索引 MEMORY.md 内容到记忆表（有 FTS5 时同步索引） */
  indexMemoryMd(content: string, sessionID: string): void {
    if (!this.db || !content) return
    try {
      this.db.run(
        "INSERT INTO fts_memory (source, content, session_id) VALUES (?, ?, ?)",
        ["memory_md", content.slice(0, 2000), sessionID],
      )
      if (this._hasFTS5) {
        this.db.run("INSERT INTO fts_memory_fts (content, session_id, source) VALUES (?, ?, ?)",
          [content.slice(0, 2000), sessionID, "memory_md"])
      }
    } catch { /* 跳过 */ }
  }

  /** 跨 session 记忆搜索 — FTS5 优先，回退到 LIKE */
  async searchMemory(query: string, limit = 3): Promise<string> {
    if (!this.db) return ""
    if (this._hasFTS5) return this.searchMemoryFTS5(query, limit)
    return this.searchMemoryLikeFallback(query, limit)
  }

  /**
   * 按项目过滤的记忆搜索。
   *
   * 注意：fts_memory_fts / fts_memory 位于独立的 fts-memory.db，
   * 而 sessions 表位于主库 mira.db —— 不能跨库 JOIN。
   * 这里先从主库查出该项目下的 session_id 列表，再在 FTS 库内用 IN 过滤。
   */
  async searchMemoryByProject(query: string, projectId: string, limit = 50): Promise<Array<{ content: string; source: string; sessionId: string }>> {
    if (!this.db) return []

    try {
      // 从主库（mira.db）解析该项目下的会话 ID
      let sessionIds: string[] = []
      try {
        const db = await getDbAsync()
        const rows = db.exec("SELECT session_id FROM sessions WHERE project_id = ?", [projectId])
        if (rows.length > 0 && rows[0].values) {
          sessionIds = rows[0].values.map((r) => String(r[0]))
        }
      } catch { /* 主库不可用时降级为空 */ }
      if (sessionIds.length === 0) return []

      const results: Array<{ content: string; source: string; sessionId: string }> = []
      const inClause = sessionIds.map(() => "?").join(", ")
      const tokens = (query || "").match(/[\p{L}\p{N}_]+/gu) || []

      if (this._hasFTS5) {
        const matchClause = tokens.length > 0
          ? `AND fts_memory_fts MATCH ?`
          : ""
        const stmt = this.db.prepare(`
          SELECT content, source, session_id
          FROM fts_memory_fts
          WHERE session_id IN (${inClause})
          ${matchClause}
          ORDER BY rank
          LIMIT ?
        `)
        stmt.bind(tokens.length > 0 ? [...sessionIds, FTSMemoryProvider.toFTS5Query(query), limit] : [...sessionIds, limit])
        while (stmt.step()) {
          const row = stmt.getAsObject() as Record<string, unknown>
          results.push({
            content: String(row.content || ""),
            source: String(row.source || ""),
            sessionId: String(row.session_id || ""),
          })
        }
        stmt.free()
      } else {
        const params: Array<string | number> = [...sessionIds]
        const likeClause = tokens.length > 0
          ? `AND ${tokens.map(() => "content LIKE ?").join(" AND ")}`
          : ""
        for (const t of tokens) params.push(`%${t}%`)
        const stmt = this.db.prepare(`
          SELECT content, source, session_id
          FROM fts_memory
          WHERE session_id IN (${inClause})
          ${likeClause}
          ORDER BY rowid DESC
          LIMIT ?
        `)
        stmt.bind([...params, limit])
        while (stmt.step()) {
          const row = stmt.getAsObject() as Record<string, unknown>
          results.push({
            content: String(row.content || ""),
            source: String(row.source || ""),
            sessionId: String(row.session_id || ""),
          })
        }
        stmt.free()
      }

      return results
    } catch {
      return []
    }
  }

  /** 跨 session 记忆搜索 — FTS5（直接查询 fts_memory_fts，不依赖 JOIN） */
  private async searchMemoryFTS5(query: string, limit = 3): Promise<string> {
    if (!this.db) return ""
    const ftsQuery = FTSMemoryProvider.toFTS5Query(query)
    if (!ftsQuery) return ""

    try {
      const stmt = this.db.prepare(`
        SELECT session_id, source, content,
               snippet(fts_memory_fts, 0, '<b>', '</b>', '...', 32) AS snip, rank
        FROM fts_memory_fts
        WHERE fts_memory_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      stmt.bind([ftsQuery, limit])

      const results: Array<{ source: string; content: string; sessionID: string; snippet: string; score: number }> = []
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>
        if (row.content) {
          results.push({
            source: String(row.source || ""),
            content: String(row.content),
            sessionID: String(row.session_id || ""),
            snippet: String(row.snip || "").replace(/<[^>]+>/g, "**"),
            score: row.rank !== undefined ? 1 / (1 + Number(row.rank)) : 0,
          })
        }
      }
      stmt.free()

      if (results.length === 0) return ""
      return `[跨 session 记忆]\n${results.map((r) =>
        `来源: ${r.source}\n内容: ${r.content.slice(0, 300)}`
      ).join("\n\n")}`
    } catch {
      return this.searchMemoryLikeFallback(query, limit)
    }
  }

  private async searchMemoryLikeFallback(query: string, limit = 3): Promise<string> {
    if (!this.db) return ""
    const terms = query.match(/[\p{L}\p{N}_]+/gu)
    if (!terms || terms.length === 0) return ""

    try {
      const conditions = terms.map(() => `content LIKE ?`).join(" AND ")
      const params = terms.map(t => `%${t}%`)
      const stmt = this.db.prepare(`
        SELECT source, content, session_id FROM fts_memory
        WHERE ${conditions}
        ORDER BY rowid DESC
        LIMIT ?
      `)
      stmt.bind([...params, limit])

      const results: Array<{ source: string; content: string; sessionID: string }> = []
      while (stmt.step()) {
        const row = stmt.getAsObject() as Record<string, unknown>
        if (row.content) {
          results.push({
            source: String(row.source || ""),
            content: String(row.content),
            sessionID: String(row.session_id || ""),
          })
        }
      }
      stmt.free()

      if (results.length === 0) return ""
      return `[跨 session 记忆]\n${results.map((r) =>
        `来源: ${r.source}\n内容: ${r.content.slice(0, 300)}`
      ).join("\n\n")}`
    } catch { return "" }
  }

  /** 用于 MemoryManager 的 prefetch 扩展（文件 + 记忆联合搜索） */
  async prefetchMemory(query: string): Promise<string> {
    const fileResults = await this.search(query)
    const memoryResults = await this.searchMemory(query)
    const parts = [fileResults, memoryResults].filter(Boolean)
    return parts.length > 0 ? parts.join("\n\n") : ""
  }

  /**
   * 列出记忆表中已有的内容（供会话记忆自动提取做去重与"已有记忆"提示）。
   * sessionID 为空时列出全部，默认按最近写入优先。
   */
  listMemories(sessionID?: string, limit = 64): Array<{ content: string; source: string; sessionId: string }> {
    if (!this.db) return []
    try {
      const stmt = sessionID
        ? this.db.prepare("SELECT content, source, session_id FROM fts_memory WHERE session_id = ? ORDER BY rowid DESC LIMIT ?")
        : this.db.prepare("SELECT content, source, session_id FROM fts_memory ORDER BY rowid DESC LIMIT ?")
      if (sessionID) stmt.bind([sessionID, limit])
      else stmt.bind([limit])
      const results: Array<{ content: string; source: string; sessionId: string }> = []
      while (stmt.step()) {
        const row = stmt.getAsObject() as any
        if (row && row.content) {
          results.push({ content: String(row.content), source: String(row.source || ""), sessionId: String(row.session_id || "") })
        }
      }
      stmt.free()
      return results
    } catch { return [] }
  }


  private save(): void {
    const dbPath = this.dbPath()
    if (!dbPath || !this.db) return
    try { fss.writeFileSync(dbPath, Buffer.from(this.db.export())) } catch { /* ignore */ }
  }

  private async scanFiles(dir: string): Promise<Array<{ path: string; filetype: string }>> {
    const results: Array<{ path: string; filetype: string }> = []
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = pt.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!this.ignoreDirs.has(entry.name) && !entry.name.startsWith(".")) {
            results.push(...(await this.scanFiles(fullPath)))
          }
        } else if (entry.isFile()) {
          const ext = pt.extname(entry.name).toLowerCase()
          if (!this.ignoreExts.has(ext)) {
            const stat = await fsp.stat(fullPath).catch(() => null)
            if (stat && stat.size <= this.maxFileSize) {
              results.push({ path: fullPath, filetype: ext.slice(1) || "txt" })
            }
          }
        }
      }
    } catch { /* 跳过 */ }
    return results
  }
}

