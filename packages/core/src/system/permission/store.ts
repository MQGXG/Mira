import { getDbAsync, runWrite } from "../database"
import { PermissionSet, type PermissionRule } from "./index"

export async function loadWorkspacePermissions(workspace: string): Promise<PermissionRule[]> {
  try {
    const db = await getDbAsync()
    const key = workspace.replace(/[/\\:]/g, "_")
    const result = db.exec("SELECT action, resource, effect FROM permissions WHERE workspace = ?", [key])
    if (result.length === 0) return []
    return result[0].values.map((r: any) => ({
      action: r[0] as string,
      resource: (r[1] as string) || "*",
      effect: r[2] as "allow" | "deny" | "ask",
    }))
  } catch { /* 数据库读取失败时返回空权限列表 */
    return []
  }
}

export async function saveWorkspacePermission(workspace: string, rule: PermissionRule): Promise<void> {
  const db = await getDbAsync()
  const key = workspace.replace(/[/\\:]/g, "_")
  runWrite(
    "INSERT OR REPLACE INTO permissions (workspace, action, resource, effect) VALUES (?, ?, ?, ?)",
    [key, rule.action, rule.resource || "*", rule.effect],
  )
}

export async function removeWorkspacePermission(workspace: string, action: string, resource: string): Promise<void> {
  const db = await getDbAsync()
  const key = workspace.replace(/[/\\:]/g, "_")
  runWrite("DELETE FROM permissions WHERE workspace = ? AND action = ? AND resource = ?", [key, action, resource])
}

export async function clearWorkspacePermissions(workspace: string): Promise<void> {
  const db = await getDbAsync()
  const key = workspace.replace(/[/\\:]/g, "_")
  runWrite("DELETE FROM permissions WHERE workspace = ?", [key])
}

export async function buildSavedPermissionSet(workspace: string): Promise<PermissionSet> {
  const savedRules = await loadWorkspacePermissions(workspace)
  return new PermissionSet(savedRules)
}

/** 导出工作区权限规则为 JSON 字符串 */
export async function exportPermissions(workspace: string): Promise<string> {
  const rules = await loadWorkspacePermissions(workspace)
  return JSON.stringify(rules, null, 2)
}

/** 从 JSON 字符串导入权限规则到工作区 */
export async function importPermissions(workspace: string, json: string): Promise<number> {
  const rules = PermissionSet.importRules(json).getRules()
  let count = 0
  for (const rule of rules) {
    await saveWorkspacePermission(workspace, rule)
    count++
  }
  return count
}
