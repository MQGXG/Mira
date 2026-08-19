/**
 * ScopedToolRegistry — 分层工具管理
 *
 * 对标 opencode 的 ApplicationTools + ToolRegistry 设计。
 * 进程级基础工具 + 位置级/模式级 Scope 覆盖，Stack-based 注册/注销。
 */

import type { ToolDef } from "../shared/tool"
import type { PermissionSet } from "./permission"
import type { ModelFilter } from "./registry"

// ── ToolScope 定义 ──────────────────────────────────────

export type ScopeType = "application" | "session" | "location" | "mode" | "plugin" | "mcp"

export interface ToolScope {
  /** Scope 唯一标识 */
  id: string
  /** Scope 类型 */
  type: ScopeType
  /** 该 Scope 包含的工具名集合 */
  tools: Set<string>
  /** 优先级（数字越大优先级越高，用于覆盖同名工具） */
  priority: number
  /** 是否启用 */
  enabled: boolean
  /** 创建时间 */
  createdAt: number
  /** 关联的模型过滤条件（可选） */
  modelFilter?: ModelFilter
}

/** 工具身份信息 — 用于防止过时工具调用 */
interface ToolIdentity {
  scopeId: string
  registeredAt: number
}

// ── ScopedToolRegistry ──────────────────────────────────

export class ScopedToolRegistry {
  /** 进程级基础工具 */
  private baseTools: Map<string, ToolDef> = new Map()
  /** Scope 专属工具（不属于 base） */
  private scopeTools: Map<string, ToolDef> = new Map()
  /** Scope 栈（按 priority 降序排列） */
  private scopes: ToolScope[] = []
  /** 工具身份校验：name → 注册时的 scopeId + timestamp */
  private identityMap: Map<string, ToolIdentity> = new Map()

  /**
   * 注册进程级基础工具
   * 这些工具在所有 Scope 中都可用，除非被高优先级 Scope 覆盖
   */
  registerBase(def: ToolDef): void {
    this.baseTools.set(def.name, def)
    this.identityMap.set(def.name, { scopeId: "base", registeredAt: Date.now() })
  }

  /**
   * 批量注册基础工具
   */
  registerBaseAll(defs: ToolDef[]): void {
    for (const def of defs) {
      this.registerBase(def)
    }
  }

  /**
   * 创建新 Scope
   */
  createScope(scope: Omit<ToolScope, "createdAt">): ToolScope {
    const fullScope: ToolScope = { ...scope, createdAt: Date.now() }
    this.scopes.push(fullScope)
    this.scopes.sort((a, b) => b.priority - a.priority)
    return fullScope
  }

  /**
   * 向 Scope 注册工具
   * 高 priority Scope 的同名工具会覆盖低 priority 的
   */
  registerInScope(scopeId: string, def: ToolDef): void {
    const scope = this.scopes.find(s => s.id === scopeId)
    if (!scope) throw new Error(`Scope not found: ${scopeId}`)
    scope.tools.add(def.name)
    // 存储到 scopeTools（Scope 专属工具）
    this.scopeTools.set(def.name, def)
    this.identityMap.set(def.name, { scopeId, registeredAt: Date.now() })
  }

  /**
   * 批量向 Scope 注册工具
   */
  registerAllInScope(scopeId: string, defs: ToolDef[]): void {
    for (const def of defs) {
      this.registerInScope(scopeId, def)
    }
  }

  /**
   * 注销整个 Scope（移除该 Scope 所有工具的覆盖）
   */
  removeScope(scopeId: string): void {
    const scope = this.scopes.find(s => s.id === scopeId)
    if (!scope) return

    // 清理 identityMap 和 scopeTools 中属于该 scope 的条目
    for (const toolName of scope.tools) {
      const identity = this.identityMap.get(toolName)
      if (identity?.scopeId === scopeId) {
        this.identityMap.delete(toolName)
        // 如果工具不在 baseTools 中，从 scopeTools 中删除
        if (!this.baseTools.has(toolName)) {
          this.scopeTools.delete(toolName)
        }
      }
    }

    this.scopes = this.scopes.filter(s => s.id !== scopeId)
  }

  /**
   * 获取当前生效的工具集（Stack-based 覆盖）
   * 高 priority Scope 的工具覆盖低 priority 的同名工具
   */
  resolve(
    modelFilter?: ModelFilter,
    permissions?: PermissionSet,
  ): Map<string, ToolDef> {
    const resolved = new Map<string, ToolDef>()

    // 1. 基础工具（最低优先级）
    for (const [name, def] of this.baseTools) {
      if (!permissions || permissions.isAllowed(name, def.permission)) {
        resolved.set(name, def)
      }
    }

    // 2. 按 priority 从高到低遍历 Scopes（高优先级覆盖低优先级）
    for (const scope of this.scopes) {
      if (!scope.enabled) continue

      // 模型过滤
      if (scope.modelFilter && modelFilter) {
        if (scope.modelFilter.providerID !== modelFilter.providerID ||
            scope.modelFilter.modelID !== modelFilter.modelID) {
          continue
        }
      }

      for (const toolName of scope.tools) {
        // 优先从 scopeTools 获取，其次从 baseTools 获取
        const def = this.scopeTools.get(toolName) || this.baseTools.get(toolName)
        if (!def) continue
        if (!permissions || permissions.isAllowed(toolName, undefined)) {
          resolved.set(toolName, def)
        }
      }
    }

    return resolved
  }

  /**
   * Identity 校验 — 检查工具调用时工具是否仍然有效
   * 防止跨回合的过时工具调用
   */
  validateIdentity(toolName: string, scopeId: string): boolean {
    const identity = this.identityMap.get(toolName)
    if (!identity) return false
    if (identity.scopeId !== scopeId) return false
    // 检查 scope 是否仍然存在且启用
    if (scopeId === "base") return true
    return this.scopes.some(s => s.id === scopeId && s.enabled)
  }

  /**
   * 列出所有 Scope
   */
  listScopes(): ToolScope[] {
    return [...this.scopes]
  }

  /**
   * 获取工具所属 Scope
   */
  getToolScope(toolName: string): string | undefined {
    return this.identityMap.get(toolName)?.scopeId
  }

  /**
   * 获取基础工具（不受 Scope 影响）
   */
  getBaseTool(name: string): ToolDef | undefined {
    return this.baseTools.get(name)
  }

  /**
   * 获取所有基础工具
   */
  getAllBaseTools(): Map<string, ToolDef> {
    return new Map(this.baseTools)
  }
}
