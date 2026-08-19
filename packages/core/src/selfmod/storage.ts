/**
 * 动态插件持久化 — SQLite 存储（会话级）
 *
 * 插件定义（含 client half 源码）持久化到 mira.db，进程重启后恢复。
 * 表 selfmod_plugins：按 (plugin_id, package_id) 存不可变版本。
 */

import { getDbAsync, runWrite, initDatabase } from "../system/database"
import type { DynamicPlugin, DynamicPackage, PluginId, PackageId } from "./registry"

export const SELFMOD_TABLE = "selfmod_plugins"

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS selfmod_plugins (
    session_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    package_id TEXT NOT NULL,
    name TEXT NOT NULL,
    purpose TEXT DEFAULT '',
    code TEXT NOT NULL,
    client_code TEXT,
    created_at INTEGER DEFAULT 0,
    PRIMARY KEY (plugin_id, package_id)
  )
`

export interface StoredPluginRow {
  session_id: string
  plugin_id: string
  package_id: string
  name: string
  purpose: string
  code: string
  client_code: string | null
  created_at: number
}

export class SelfModStorage {
  private ensured = false

  /** 建表（幂等） */
  async ensureTable(): Promise<void> {
    if (this.ensured) return
    await initDatabase()
    const db = await getDbAsync()
    db.run(CREATE_SQL)
    this.ensured = true
  }

  /** 持久化一个插件的所有版本 */
  async savePlugin(sessionId: string, plugin: DynamicPlugin): Promise<void> {
    await this.ensureTable()
    for (const pkg of plugin.packages.values()) {
      runWrite(
        `INSERT OR REPLACE INTO selfmod_plugins
          (session_id, plugin_id, package_id, name, purpose, code, client_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, plugin.pluginId, pkg.packageId, pkg.name, pkg.purpose, pkg.code, pkg.clientCode ?? null, pkg.createdAt],
      )
    }
  }

  /** 删除插件的所有版本 */
  async deletePlugin(sessionId: string, pluginId: PluginId): Promise<void> {
    await this.ensureTable()
    runWrite("DELETE FROM selfmod_plugins WHERE session_id = ? AND plugin_id = ?", [sessionId, pluginId])
  }

  /** 加载某会话的插件定义（含全部版本） */
  async loadBySession(sessionId: string): Promise<Array<{ sessionId: string; pluginId: string; packages: DynamicPackage[] }>> {
    return this.load(`WHERE session_id = ?`, [sessionId])
  }

  /** 加载全部（供装配时全局恢复） */
  async loadAll(): Promise<Array<{ sessionId: string; pluginId: string; packages: DynamicPackage[] }>> {
    return this.load("", [])
  }

  private async load(where: string, params: (string | number)[]): Promise<Array<{ sessionId: string; pluginId: string; packages: DynamicPackage[] }>> {
    await this.ensureTable()
    const db = await getDbAsync()
    const result = db.exec(`SELECT session_id, plugin_id, package_id, name, purpose, code, client_code, created_at FROM selfmod_plugins ${where} ORDER BY created_at ASC`, params as never[])
    if (result.length === 0) return []
    const rows: StoredPluginRow[] = result[0].values.map((r) => ({
      session_id: String(r[0]),
      plugin_id: String(r[1]),
      package_id: String(r[2]),
      name: String(r[3]),
      purpose: String(r[4]),
      code: String(r[5]),
      client_code: r[6] ? String(r[6]) : null,
      created_at: Number(r[7]),
    }))
    // 按 plugin 分组
    const byPlugin = new Map<string, { sessionId: string; pluginId: string; packages: DynamicPackage[] }>()
    for (const row of rows) {
      const key = row.plugin_id
      if (!byPlugin.has(key)) {
        byPlugin.set(key, { sessionId: row.session_id, pluginId: row.plugin_id, packages: [] })
      }
      const pkg: DynamicPackage = {
        packageId: row.package_id as PackageId,
        name: row.name,
        purpose: row.purpose,
        code: row.code,
        ...(row.client_code ? { clientCode: row.client_code } : {}),
        createdAt: row.created_at,
      }
      byPlugin.get(key)!.packages.push(pkg)
    }
    return [...byPlugin.values()]
  }
}

/** 模块级单例（装配时创建） */
export const selfModStorage = new SelfModStorage()
