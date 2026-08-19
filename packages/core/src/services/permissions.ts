/**
 * 权限服务 — ctx.permissions
 * 对齐 dsh 权限 seam：allow/deny/ask 三层 Gate + 可逆规则注册
 */

import { Service } from "../vendor/cordis/index"
import { PermissionSet } from "../system/permission"
import type { PermissionRule } from "../system/permission"
import type { PermissionService } from "../framework/context"

export class MiraPermissionService extends Service implements PermissionService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "permissions"
  private permissionSet: PermissionSet

  constructor(ctx: import("../vendor/cordis/index").Context, config: { rules?: PermissionRule[] } = {}) {
    super(ctx, "permissions")
    this.permissionSet = new PermissionSet(config.rules)
  }

  evaluate(action: string, permission?: string): "allow" | "deny" | "ask" {
    return this.permissionSet.evaluate(action, permission)
  }

  isAllowed(action: string, permission?: string): boolean {
    return this.permissionSet.isAllowed(action, permission)
  }

  needsApproval(action: string, resource?: string | string[]): boolean {
    return this.permissionSet.needsApproval(action, resource)
  }

  setRules(rules: PermissionRule[]): void {
    this.permissionSet = new PermissionSet(rules)
  }

  addRule(rule: PermissionRule): void {
    this.permissionSet.addRule(rule)
  }

  /** 可逆注册：追加规则并返回 disposer */
  addRuleEffectively(rule: PermissionRule): () => void {
    this.permissionSet.addRule(rule)
    return () => this.permissionSet.removeRule(rule)
  }

  getAll(): PermissionRule[] {
    return this.permissionSet.getAll()
  }
}
