/**
 * Recovery 层 — 失败路径升级决策（三层分离之一）
 * Planner 负责"怎么走"（图定义），Runtime 负责"执行"，
 * Recovery 负责"执行失败后怎么收敛"：
 *   1. 单节点重入上限（防 fix→test 死循环）
 *   2. 全局执行次数上限（防总循环）
 *   3. 超限后升级决策（fail 终止 / escalate 走失败回退边）
 */

import type { RecoveryPolicy } from "./types"

/** 恢复决策结果 */
export interface RecoveryDecision {
  /** 是否允许继续执行该节点 */
  allowed: boolean
  /** 决策原因（事件/日志用） */
  reason?: string
}

/** Recovery 运行时状态：累计各节点重入次数 */
export class Recovery {
  private reentryCounts = new Map<string, number>()
  private totalExecutions = 0

  constructor(private policy?: RecoveryPolicy) {}

  /** 节点执行前登记，返回是否允许执行（超限返回 false） */
  beforeNode(nodeId: string): RecoveryDecision {
    this.totalExecutions++
    if (this.policy?.maxTotalExecutions && this.totalExecutions > this.policy.maxTotalExecutions) {
      return { allowed: false, reason: `total executions exceeded (${this.totalExecutions}/${this.policy.maxTotalExecutions})` }
    }
    const current = (this.reentryCounts.get(nodeId) || 0) + 1
    this.reentryCounts.set(nodeId, current)
    const max = this.policy?.maxReentries?.[nodeId]
    if (max !== undefined && current > max) {
      return { allowed: false, reason: `node "${nodeId}" re-entered ${current} times (limit ${max})` }
    }
    return { allowed: true }
  }

  /** 超限后的升级行为 */
  escalate(_nodeId: string): "fail" | "escalate" {
    return this.policy?.onExhausted ?? "fail"
  }

  /** 当前重入次数（供测试断言） */
  reentryCount(nodeId: string): number {
    return this.reentryCounts.get(nodeId) || 0
  }

  reset(): void {
    this.reentryCounts.clear()
    this.totalExecutions = 0
  }
}

/** 便捷：合并多段 recovery 策略（后者覆盖同名 key） */
export function mergeRecoveryPolicies(...policies: Array<RecoveryPolicy | undefined>): RecoveryPolicy | undefined {
  const merged: RecoveryPolicy = {}
  for (const p of policies) {
    if (!p) continue
    if (p.maxReentries) {
      merged.maxReentries = { ...(merged.maxReentries || {}), ...p.maxReentries }
    }
    if (p.maxTotalExecutions !== undefined) merged.maxTotalExecutions = p.maxTotalExecutions
    if (p.onExhausted) merged.onExhausted = p.onExhausted
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}
