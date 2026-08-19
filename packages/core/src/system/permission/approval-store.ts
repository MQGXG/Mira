/**
 * 审批缓存 — 参考 Codex 的 ApprovalStore + opencode 的通配符规则
 * 缓存用户审批决策，避免重复弹窗，支持通配符资源匹配
 * 持久化规则通过 PermissionSet 注入，重启后不丢失
 */

import { saveWorkspacePermission } from "./store"
import type { PermissionSet } from "./index"

export interface ApprovalRecord {
  action: string
  resources: string[]
  decision: "allow" | "deny"
  timestamp: number
  ttlMs: number
}

/** 简单通配符匹配，支持 * 和 ** */
function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern === value) return true
  if (!pattern.includes("*")) return false

  const pSegments = pattern.split("/")
  const vSegments = value.split("/")

  return matchSegments(pSegments, vSegments, 0, 0)
}

function matchSegments(p: string[], v: string[], pi: number, vi: number): boolean {
  if (pi >= p.length) return vi >= v.length
  if (p[pi] === "**") {
    if (pi === p.length - 1) return true
    for (let i = vi; i < v.length; i++) {
      if (matchSegments(p, v, pi + 1, i)) return true
    }
    return false
  }
  if (vi >= v.length) return false
  return segmentMatch(p[pi], v[vi]) && matchSegments(p, v, pi + 1, vi + 1)
}

function segmentMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const reStr = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
  return new RegExp(reStr).test(value)
}

export class ApprovalStore {
  private cache = new Map<string, ApprovalRecord>()
  private permissions: PermissionSet | null = null

  /** 注入持久化权限集（启动时从 SQLite 加载） */
  setPermissions(permissions: PermissionSet): void {
    this.permissions = permissions
  }

  private key(action: string, resource: string): string {
    return `${action}:${resource}`
  }

  /** 记录审批决策 */
  record(action: string, resources: string[], decision: "allow" | "deny", ttlMs = 300_000, workspace?: string): void {
    const now = Date.now()
    for (const r of resources) {
      this.cache.set(this.key(action, r), { action, resources: [r], decision, timestamp: now, ttlMs })
    }
    // "始终允许"同步持久化到 SQLite
    if (decision === "allow" && workspace) {
      for (const r of resources) {
        saveWorkspacePermission(workspace, { action, resource: r, effect: "allow" }).catch(() => {})
      }
    }
  }

  /** 检查是否有缓存的审批决策 — 支持通配符匹配缓存 key */
  check(action: string, resource: string): "allow" | "deny" | null {
    // 先查持久化权限集（自带通配符匹配）
    if (this.permissions) {
      const effect = this.permissions.evaluate(action)
      if (effect === "allow") return "allow"
      if (effect === "deny") return "deny"
    }
    // 再查内存缓存 — 遍历所有 key 做通配符匹配
    const now = Date.now()
    for (const [key, record] of this.cache) {
      const [cachedAction, cachedResource] = key.split(":")
      if (!wildcardMatch(cachedAction, action)) continue
      if (!wildcardMatch(cachedResource, resource)) continue
      if (now - record.timestamp > record.ttlMs) {
        this.cache.delete(key)
        continue
      }
      return record.decision
    }
    return null
  }

  /** 检查一组资源是否全部被允许 */
  checkAll(action: string, resources: string[]): "allow" | null {
    for (const r of resources) {
      const result = this.check(action, r)
      if (result !== "allow") return null
    }
    return "allow"
  }

  /** 清除过期缓存 */
  purge(): void {
    const now = Date.now()
    for (const [key, record] of this.cache) {
      if (now - record.timestamp > record.ttlMs) {
        this.cache.delete(key)
      }
    }
  }

  /** 清除所有缓存 */
  clear(): void {
    this.cache.clear()
  }
}
