/**
 * 插件激活 WAL — 移植 dsh-plugin-desktop install-recovery 的状态机到 SQLite
 *
 * 目标：为"运行期自修改"提供 last-known-good 激活集。
 * - begin：激活前记录（目标版本 + 上一个健康版本）
 * - seal：激活成功（进程可能随时崩溃，故留下 awaiting-restart 待下次启动验证）
 * - markHealthy：确认健康 → verified
 * - recover：激活失败/崩溃恢复 → 回滚到上一个健康版本
 * - clear：删除已了结的事务
 * 正常路径立即 seal→markHealthy→clear（Mira 激活即时生效）；崩溃窗口留下的
 * prepared/awaiting-restart 记录由 recoverPending() 在下次启动时处理。
 */

import { getDbAsync, runWrite, initDatabase } from "../system/database"
import { randomUUID } from "node:crypto"
import type { PluginId, PackageId } from "./registry"
import type { DynamicPluginRunner } from "./runner"

export const RECOVERY_TABLE = "selfmod_recovery"

export const RECOVERY_PHASES = [
  "prepared",
  "awaiting-restart",
  "verifying",
  "recovery-pending",
  "verified",
  "rolled-back",
  "manual-recovery-required",
] as const

export type RecoveryPhase = (typeof RECOVERY_PHASES)[number]

export type RecoveryAction = "run" | "update" | "stop" | "undefine"

export type RecoveryFailureReason =
  | "install-failed"
  | "interrupted-install"
  | "startup-failed"
  | "startup-unconfirmed"

export interface RecoveryTransaction {
  sessionId: string
  pluginId: string
  transactionId: string
  phase: RecoveryPhase
  action: RecoveryAction
  targetPackageId: string
  prevPackageId: string | null
  createdAt: number
  sealedAt: number | null
  verifiedAt: number | null
  restoredAt: number | null
  failureReason: RecoveryFailureReason | null
}

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS ${RECOVERY_TABLE} (
    session_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    transaction_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    action TEXT NOT NULL,
    target_package_id TEXT NOT NULL,
    prev_package_id TEXT,
    created_at INTEGER NOT NULL,
    sealed_at INTEGER,
    verified_at INTEGER,
    restored_at INTEGER,
    failure_reason TEXT,
    PRIMARY KEY (session_id, transaction_id)
  )
`

const PENDING_PHASES = "('prepared', 'awaiting-restart', 'verifying', 'recovery-pending')"

function isPhase(value: unknown): value is RecoveryPhase {
  return typeof value === "string" && (RECOVERY_PHASES as readonly string[]).includes(value)
}

function isAction(value: unknown): value is RecoveryAction {
  return value === "run" || value === "update" || value === "stop" || value === "undefine"
}

function isReason(value: unknown): value is RecoveryFailureReason {
  return value === "install-failed" || value === "interrupted-install"
    || value === "startup-failed" || value === "startup-unconfirmed"
}

/** 行 → 事务对象（带形状校验，防脏数据） */
function rowToTransaction(row: unknown[]): RecoveryTransaction {
  const [sessionId, pluginId, transactionId, phase, action, targetPackageId, prevPackageId, createdAt, sealedAt, verifiedAt, restoredAt, failureReason] = row as [
    string, string, string, unknown, unknown, string, string | null, number,
    number | null, number | null, number | null, string | null,
  ]
  if (typeof sessionId !== "string" || typeof pluginId !== "string" || typeof transactionId !== "string"
    || !isPhase(phase) || !isAction(action) || typeof targetPackageId !== "string"
    || (prevPackageId !== null && typeof prevPackageId !== "string")
    || typeof createdAt !== "number"
    || (sealedAt !== null && typeof sealedAt !== "number")
    || (verifiedAt !== null && typeof verifiedAt !== "number")
    || (restoredAt !== null && typeof restoredAt !== "number")
    || (failureReason !== null && !isReason(failureReason))) {
    throw new Error("selfmod_recovery 行数据非法")
  }
  return {
    sessionId, pluginId, transactionId, phase, action, targetPackageId,
    prevPackageId, createdAt, sealedAt, verifiedAt, restoredAt, failureReason,
  }
}

export class PluginRecoveryStore {
  private ensured = false

  async ensureTable(): Promise<void> {
    if (this.ensured) return
    await initDatabase()
    const db = await getDbAsync()
    db.run(CREATE_SQL)
    this.ensured = true
  }

  /** 开始一笔激活事务（覆盖该插件旧事务，保持同一时刻仅一笔） */
  async begin(
    sessionId: string,
    pluginId: string,
    action: RecoveryAction,
    targetPackageId: string,
    prevPackageId: string | null | undefined,
  ): Promise<RecoveryTransaction> {
    await this.ensureTable()
    const previous = prevPackageId ?? null
    const transactionId = `rec-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    runWrite(
      `DELETE FROM ${RECOVERY_TABLE} WHERE session_id = ? AND plugin_id = ?`,
      [sessionId, pluginId],
    )
    runWrite(
      `INSERT INTO ${RECOVERY_TABLE}
        (session_id, plugin_id, transaction_id, phase, action, target_package_id,
         prev_package_id, created_at, sealed_at, verified_at, restored_at, failure_reason)
       VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      [sessionId, pluginId, transactionId, action, targetPackageId, previous, Date.now()],
    )
    return this.requireTransaction(sessionId, transactionId)
  }

  /** 激活成功：seal（留待下次启动验证） */
  async seal(sessionId: string, transactionId: string): Promise<RecoveryTransaction> {
    await this.ensureTable()
    runWrite(
      `UPDATE ${RECOVERY_TABLE} SET phase = 'awaiting-restart', sealed_at = ?
       WHERE session_id = ? AND transaction_id = ? AND phase IN ('prepared')`,
      [Date.now(), sessionId, transactionId],
    )
    return this.requirePhase(sessionId, transactionId, "awaiting-restart")
  }

  /** 确认健康（本次运行验证通过） */
  async markHealthy(sessionId: string, transactionId: string): Promise<RecoveryTransaction> {
    await this.ensureTable()
    runWrite(
      `UPDATE ${RECOVERY_TABLE} SET phase = 'verified', verified_at = ?
       WHERE session_id = ? AND transaction_id = ? AND phase IN ('awaiting-restart')`,
      [Date.now(), sessionId, transactionId],
    )
    return this.requirePhase(sessionId, transactionId, "verified")
  }

  /** 激活失败/崩溃恢复：回滚到上一个健康版本 */
  async recover(
    sessionId: string,
    transactionId: string,
    failureReason: RecoveryFailureReason,
  ): Promise<RecoveryTransaction> {
    await this.ensureTable()
    runWrite(
      `UPDATE ${RECOVERY_TABLE} SET phase = 'rolled-back', restored_at = ?, failure_reason = ?
       WHERE session_id = ? AND transaction_id = ? AND phase IN ('prepared', 'awaiting-restart', 'verifying')`,
      [Date.now(), failureReason, sessionId, transactionId],
    )
    return this.requirePhase(sessionId, transactionId, "rolled-back")
  }

  /** 删除已了结的事务 */
  async clear(sessionId: string, transactionId: string): Promise<void> {
    await this.ensureTable()
    runWrite(
      `DELETE FROM ${RECOVERY_TABLE} WHERE session_id = ? AND transaction_id = ?`,
      [sessionId, transactionId],
    )
  }

  /** 查询未决事务（崩溃窗口残留） */
  async pending(sessionId?: string): Promise<RecoveryTransaction[]> {
    await this.ensureTable()
    const db = await getDbAsync()
    const where = sessionId ? `WHERE session_id = ? AND phase IN ${PENDING_PHASES}` : `WHERE phase IN ${PENDING_PHASES}`
    const params = sessionId ? [sessionId] : []
    const result = db.exec(
      `SELECT session_id, plugin_id, transaction_id, phase, action, target_package_id,
              prev_package_id, created_at, sealed_at, verified_at, restored_at, failure_reason
       FROM ${RECOVERY_TABLE} ${where} ORDER BY created_at ASC`,
      params,
    )
    if (result.length === 0) return []
    return result[0].values.map((row) => rowToTransaction(row))
  }

  private async requireTransaction(sessionId: string, transactionId: string): Promise<RecoveryTransaction> {
    const db = await getDbAsync()
    const result = db.exec(
      `SELECT session_id, plugin_id, transaction_id, phase, action, target_package_id,
              prev_package_id, created_at, sealed_at, verified_at, restored_at, failure_reason
       FROM ${RECOVERY_TABLE} WHERE session_id = ? AND transaction_id = ?`,
      [sessionId, transactionId] as never[],
    )
    if (result.length === 0) throw new Error(`selfmod 恢复事务不存在: ${transactionId}`)
    return rowToTransaction(result[0].values[0])
  }

  /** 读回并校验相位转移结果（前置相位不满足时 UPDATE 未生效，抛错） */
  private async requirePhase(
    sessionId: string,
    transactionId: string,
    expected: RecoveryPhase,
  ): Promise<RecoveryTransaction> {
    const db = await getDbAsync()
    if (db.getRowsModified() === 0) {
      throw new Error(`selfmod 恢复事务状态非法: ${transactionId}（相位转移未生效，期望 → ${expected}）`)
    }
    const txn = await this.requireTransaction(sessionId, transactionId)
    if (txn.phase !== expected) {
      throw new Error(`selfmod 恢复事务状态非法: ${transactionId} phase=${txn.phase}，期望 ${expected}`)
    }
    return txn
  }
}

/** 模块级单例（装配时创建） */
export const pluginRecoveryStore = new PluginRecoveryStore()

export interface RecoverPendingOptions {
  store?: PluginRecoveryStore
  runner: DynamicPluginRunner
}

/**
 * 处理崩溃残留的未决事务：
 * - 有 prev 健康版本：回滚记录 + 用 prev 版本重新激活（last-known-good 恢复）
 * - 无 prev：保持未运行，清除事务
 * - 恢复激活失败：标记为回滚并记录失败原因
 * 单个事务处理失败不中断循环：runner.run 内部可能已 begin 覆盖并自行了结原事务
 * （如 activate 失败时 recover("install-failed")），此时对已删除的原始 transactionId 调 recover
 * 会因 requirePhase 检测 getRowsModified()===0 抛"状态非法"——所有 store.recover 调用均吞掉
 * 此类异常，剩余未决事务继续处理。
 */
export async function recoverPending(options: RecoverPendingOptions): Promise<number> {
  const store = options.store ?? pluginRecoveryStore
  const pending = await store.pending()
  let handled = 0
  for (const txn of pending) {
    // 注意：运算符优先级 — 必须加括号，否则 `&&` 优先于 `||` 导致 action=update 且 prev 为 null 时误入恢复分支
    if (txn.prevPackageId !== null && (txn.action === "run" || txn.action === "update")) {
      try {
        const res = await options.runner.run(
          txn.sessionId,
          txn.pluginId as PluginId,
          txn.prevPackageId as PackageId,
          "run",
          { recoveryStore: store },
        )
        if (res.ok) {
          await store.clear(txn.sessionId, txn.transactionId)
        } else {
          await store.recover(txn.sessionId, txn.transactionId, "startup-failed").catch(() => {})
        }
      } catch {
        await store.recover(txn.sessionId, txn.transactionId, "startup-failed").catch(() => {})
      }
    } else {
      await store.recover(txn.sessionId, txn.transactionId, "interrupted-install").catch(() => {})
    }
    handled++
  }
  return handled
}
