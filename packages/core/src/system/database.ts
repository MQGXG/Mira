import initSqlJs, { type Database as SqliteDb } from "sql.js"
import { getPlatformPaths } from "../config/paths"
import { join } from "path"
import fs from "fs"

let db: SqliteDb | null = null
let dbInitPromise: Promise<SqliteDb> | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let _SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null

function getDbPath(): string | null {
  try {
    return join(getPlatformPaths().userData, "mira.db")
  } catch {
    return null // 测试环境中 app 不可用
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY, name TEXT NOT NULL,
    workspace_path TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '',
    workspace TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    cost REAL DEFAULT 0,
    tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
    tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now')), tool_call_id TEXT,
    retry_count INTEGER DEFAULT 0,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
  );
  -- 迁移：兼容旧表（如果 retry_count 列不存在则添加）
  -- SQLite 不支持 IF NOT EXISTS for ALTER TABLE, 使用 try-catch 方式
  CREATE TABLE IF NOT EXISTS permissions (
    workspace TEXT NOT NULL, action TEXT NOT NULL,
    resource TEXT DEFAULT '*', effect TEXT NOT NULL,
    PRIMARY KEY (workspace, action, resource)
  );
  CREATE TABLE IF NOT EXISTS actor_registry (
    actor_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_actor_id TEXT,
    mode TEXT NOT NULL DEFAULT 'subagent',
    status TEXT NOT NULL DEFAULT 'pending',
    description TEXT,
    context_mode TEXT DEFAULT 'none',
    agent TEXT,
    result TEXT,
    error TEXT,
    turn_count INTEGER DEFAULT 0,
    time_created TEXT DEFAULT (datetime('now')),
    time_updated TEXT DEFAULT (datetime('now')),
    time_completed TEXT,
    lifecycle TEXT DEFAULT 'ephemeral'
  );
  CREATE TABLE IF NOT EXISTS goals (
    session_id TEXT NOT NULL, id TEXT NOT NULL,
    description TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'active', satisfied_at TEXT,
    timeout_ms INTEGER DEFAULT 0,
    evaluations_json TEXT DEFAULT '[]',
    PRIMARY KEY (session_id, id)
  );
  -- 事件溯源表（Event Sourcing）
  CREATE TABLE IF NOT EXISTS session_events (
    seq INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT DEFAULT (datetime('now')),
    version INTEGER DEFAULT 1,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, seq);
  CREATE TABLE IF NOT EXISTS event_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    up_to_seq INTEGER NOT NULL,
    messages_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_session ON event_snapshots(session_id, up_to_seq);
  -- Todo 表
  CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 0,
    parent_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id, status);
`

async function createDb(): Promise<SqliteDb> {
  _SQL = await initSqlJs()
  const dbPath = getDbPath()
  let buffer: Buffer | undefined
  if (dbPath) {
    try {
      const dir = getPlatformPaths().userData
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      if (fs.existsSync(dbPath)) buffer = fs.readFileSync(dbPath)
    } catch { /* 首次启动无已有 db 文件 */ }
  }
  const newDb = new _SQL.Database(buffer)
  newDb.run("PRAGMA journal_mode=WAL")
  newDb.run(SCHEMA)
  // FTS5 全文搜索（sql.js WASM 可能不支持，静默失败）
  try {
    newDb.run(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(session_id, role, content)`)
  } catch { /* FTS5 不可用，搜索将使用 LIKE 回退 */ }
  // 迁移：为旧表添加 retry_count 列（如果不存在）
  try { newDb.run("ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0") } catch { /* 列已存在 */ }
  try { newDb.run("ALTER TABLE actor_registry ADD COLUMN context_mode TEXT DEFAULT 'none'") } catch { /* 列已存在或表刚创建 */ }
  // 迁移：sessions 表成本/token 列（旧库升级）
  try { newDb.run("ALTER TABLE sessions ADD COLUMN cost REAL DEFAULT 0") } catch { /* 列已存在 */ }
  try { newDb.run("ALTER TABLE sessions ADD COLUMN tokens_input INTEGER DEFAULT 0") } catch { /* 列已存在 */ }
  try { newDb.run("ALTER TABLE sessions ADD COLUMN tokens_output INTEGER DEFAULT 0") } catch { /* 列已存在 */ }
  try { newDb.run("ALTER TABLE sessions ADD COLUMN tokens_reasoning INTEGER DEFAULT 0") } catch { /* 列已存在 */ }
  try { newDb.run("ALTER TABLE sessions ADD COLUMN tokens_cache_read INTEGER DEFAULT 0") } catch { /* 列已存在 */ }
  try { newDb.run("ALTER TABLE sessions ADD COLUMN tokens_cache_write INTEGER DEFAULT 0") } catch { /* 列已存在 */ }
  return newDb
}

export async function initDatabase(): Promise<SqliteDb> {
  if (db) return db
  if (dbInitPromise) return dbInitPromise
  dbInitPromise = createDb()
  db = await dbInitPromise
  return db
}

export async function getDbAsync(): Promise<SqliteDb> {
  if (db) return db
  return initDatabase()
}

/** 重载数据库文件（跨进程同步：Sidecar 写入后主进程需要重读） */
export function reloadDatabase(): void {
  if (!_SQL) return
  const dbPath = getDbPath()
  if (!dbPath) return
  try {
    // 先强制持久化内存中未写入磁盘的变更，防止后续读取旧数据覆盖内存状态
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (db) {
      const data = db.export()
      const buffer = Buffer.from(data)
      fs.writeFileSync(dbPath, buffer)
    }
    // 从磁盘重新加载
    const fresh = fs.readFileSync(dbPath)
    if (db) db.close()
    db = new _SQL.Database(fresh)
    db.run("PRAGMA journal_mode=WAL")
  } catch { /* 文件不存在或读取失败时保留当前内存数据库 */ }
}

/** 执行 SQL 写入并自动触发持久化 */
export function runWrite(sql: string, params?: any[]): void {
  if (!db) throw new Error("数据库未初始化")
  // 参数类型安全校验：防止对象被误传为参数
  if (params) {
    for (let i = 0; i < params.length; i++) {
      if (typeof params[i] === "object" && params[i] !== null) {
        params[i] = JSON.stringify(params[i])
      }
    }
  }
  db.run(sql, params)
  scheduleSave()
}

/** 异步持久化到磁盘（防抖 500ms） */
export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!db) return
    void persist()
  }, 500)
}

/** 立即持久化 */
export function flushSave(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (!db) return
  void persist()
}

let persisting = false

async function persist(): Promise<void> {
  if (persisting) return
  persisting = true
  const p = getDbPath()
  if (!p) { persisting = false; return }
  try {
    const data = db!.export()
    const buffer = Buffer.from(data)
    await fs.promises.writeFile(p, buffer)
  } catch {
    // 持久化失败时静默处理，下次写入会重试
  } finally {
    persisting = false
  }
}

