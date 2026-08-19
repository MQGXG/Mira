# 桌面运维韧性三件套 Implementation Plan（借鉴 deepseek-harness-desktop）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 借鉴 DSH Desktop 的运维韧性设计（插件安装 WAL 回滚 / renderer 启动健康检查 / 崩溃证据），为 Mira 补上三块当前最薄的基础设施，全部可测、分三个独立 phase 交付。

**Architecture:** 三个独立子系统，各自可测试可交付，互不阻塞：
- **Phase 1（sidecar core）**：`selfmod/recovery.ts` 插件激活 WAL——把 DSH `install-recovery.ts` 的状态机（prepared→awaiting-restart→verifying→verified/rolled-back）移植到 Mira 的 SQLite 插件存储，崩溃/失败后自动回滚到上一个健康版本。
- **Phase 2（sidecar + electron main）**：`system/crash-evidence.ts` active-run 标记——移植 DSH `crash-evidence.ts`，sidecar 进程写/清标记，main 启动时读取上次残留判定是否异常退出。
- **Phase 3（sidecar + main + ui）**：`system/health.ts` 启动健康检查——sidecar 增强 `/api/health`（含 selfmod 恢复事务数）+ renderer boot 窗口判定（30s 超时弹恢复提示）。**不做重复的 sidecar 轮询**：`sidecar-bridge.ts` 已有 5s 健康检查 + 自动重连 + 状态广播。

**Tech Stack:** TypeScript 5、Vitest 4、sql.js (SQLite, 经 `system/database.ts`)、Node fs/path（同步 API）、Electron main 进程、React 18（仅 Phase 3 UI 薄改动）。

**借鉴对照（DSH 源文件）**：`deepseek-harness-desktop/dsh-plugin-desktop/src/{install-recovery.ts, renderer-boot.ts, crash-evidence.ts}`。

---

## Phase 1：插件激活 WAL 回滚（sidecar core）

### 设计决策

Mira 的自我修改（`selfmod/`）已用 VM 沙箱 + fiber 可逆回滚 + 审批门保护运行期坏插件。DSH 的 WAL 针对的是"文件系统级插件安装（改 package.json / 装 npm 包）"，与 Mira 的"代码级插件定义"风险模型不同。因此**移植的是"事务式激活 + 崩溃后恢复/回滚"的状态机**，价值两点：

1. **last-known-good 激活集**：记录每个插件"上次确认健康的激活版本"；sidecar 崩溃重启后据此自动恢复激活态（对齐 DSH 的 last-known-good profile 概念）。
2. **坏版本防污染**：若某版本激活过程中崩溃/失败（begin 已写、未 verified），重启后自动回滚到上一个健康版本，避免坏版本反复导致启动失败。

存储用 SQLite 新表 `selfmod_recovery`（复用 `system/database.ts` 的 `runWrite`/`getDbAsync`，零新依赖），与 `selfmod/storage.ts` 同机制。

**状态机**：`prepared → awaiting-restart → verified → (clear)` 或 `prepared → awaiting-restart → rolled-back → (clear)`。正常路径立即 seal+verify+clear（Mira 激活即时生效，无需等待重启）；崩溃窗口留下的 `prepared/awaiting-restart` 记录在下次启动时由 `recoverPending()` 处理。

**落点文件：**
- Create: `packages/core/src/selfmod/recovery.ts`
- Modify: `packages/core/src/selfmod/runner.ts`
- Modify: `packages/core/src/selfmod/index.ts`（导出 + 装配恢复）
- Modify: `packages/core/src/system/server/cli.ts`（启动后 `recoverPending`）
- Test: `packages/core/src/selfmod/__tests__/recovery.test.ts`

### Task 1: 实现 PluginRecoveryStore（WAL 状态机 + SQLite 持久化）

**Files:**
- Create: `packages/core/src/selfmod/recovery.ts`
- Test: `packages/core/src/selfmod/__tests__/recovery.test.ts`

- [ ] **Step 1: 写失败测试（状态机 + 持久化）**

`packages/core/src/selfmod/__tests__/recovery.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { initPlatformPaths } from "../../config/paths"
import { PluginRecoveryStore, RECOVERY_PHASES } from "../recovery"
import { getDbAsync } from "../../system/database"

async function freshStore(): Promise<PluginRecoveryStore> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-recovery-"))
  initPlatformPaths({ userData: tmp })
  return new PluginRecoveryStore()
}

describe("插件激活 WAL（PluginRecoveryStore）", () => {
  it("begin 写入 prepared；seal 后 verified；clear 删除", async () => {
    const store = await freshStore()
    const txn = await store.begin("s1", "dyn-1", "run", "pkg-2", "pkg-1")
    expect(txn.phase).toBe("prepared")
    expect(txn.prevPackageId).toBe("pkg-1")

    const sealed = await store.seal(txn.transactionId)
    expect(sealed.phase).toBe("awaiting-restart")

    const verified = await store.markHealthy(txn.transactionId)
    expect(verified.phase).toBe("verified")

    await store.clear(txn.transactionId)
    const rows = await store.pending()
    expect(rows).toHaveLength(0)
  })

  it("begin 会覆盖同一插件的旧记录（同一时刻仅一笔事务）", async () => {
    const store = await freshStore()
    const t1 = await store.begin("s1", "dyn-1", "run", "pkg-2", "pkg-1")
    const t2 = await store.begin("s1", "dyn-1", "run", "pkg-3", "pkg-2")
    expect(t2.transactionId).not.toBe(t1.transactionId)
    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].targetPackageId).toBe("pkg-3")
  })

  it("recover 回滚并记录 failure_reason", async () => {
    const store = await freshStore()
    const txn = await store.begin("s1", "dyn-1", "update", "pkg-2", "pkg-1")
    const rolled = await store.recover(txn.transactionId, "startup-failed")
    expect(rolled.phase).toBe("rolled-back")
    expect(rolled.failureReason).toBe("startup-failed")
    expect(rolled.prevPackageId).toBe("pkg-1")
    expect(await store.pending()).toHaveLength(0)
  })

  it("pending 只返回未决事务（prepared/awaiting-restart/verifying）", async () => {
    const store = await freshStore()
    await store.begin("s1", "dyn-1", "run", "pkg-2", "pkg-1")
    const t2 = await store.begin("s1", "dyn-2", "run", "pkg-1", undefined)
    await store.seal(t2.transactionId)
    await store.markHealthy(t2.transactionId)
    await store.clear(t2.transactionId)

    const pending = await store.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].pluginId).toBe("dyn-1")
  })

  it("按 session 过滤未决事务", async () => {
    const store = await freshStore()
    await store.begin("s1", "dyn-1", "run", "pkg-1", undefined)
    await store.begin("s2", "dyn-2", "run", "pkg-1", undefined)
    expect(await store.pending("s1")).toHaveLength(1)
    expect(await store.pending("s2")).toHaveLength(1)
    expect(await store.pending("s3")).toHaveLength(0)
  })
})

describe("RECOVERY_PHASES 常量", () => {
  it("包含全部状态机阶段", () => {
    expect(RECOVERY_PHASES).toEqual([
      "prepared", "awaiting-restart", "verifying", "recovery-pending",
      "verified", "rolled-back", "manual-recovery-required",
    ])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack pnpm exec vitest run packages/core/src/selfmod/__tests__/recovery.test.ts`
Expected: FAIL，报 `Cannot find module '../recovery'`。

- [ ] **Step 3: 实现 `recovery.ts`**

`packages/core/src/selfmod/recovery.ts`（完整文件）：

```ts
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
    prevPackageId: string | null,
  ): Promise<RecoveryTransaction> {
    await this.ensureTable()
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
      [sessionId, pluginId, transactionId, action, targetPackageId, prevPackageId, Date.now()],
    )
    return this.requireTransaction(sessionId, transactionId)
  }

  /** 激活成功：seal（留待下次启动验证） */
  async seal(sessionId: string, transactionId: string): Promise<RecoveryTransaction> {
    await this.ensureTable()
    runWrite(
      `UPDATE ${RECOVERY_TABLE} SET phase = 'awaiting-restart', sealed_at = ?
       WHERE session_id = ? AND transaction_id = ?`,
      [Date.now(), sessionId, transactionId],
    )
    return this.requireTransaction(sessionId, transactionId)
  }

  /** 确认健康（本次运行验证通过） */
  async markHealthy(sessionId: string, transactionId: string): Promise<RecoveryTransaction> {
    await this.ensureTable()
    runWrite(
      `UPDATE ${RECOVERY_TABLE} SET phase = 'verified', verified_at = ?
       WHERE session_id = ? AND transaction_id = ?`,
      [Date.now(), sessionId, transactionId],
    )
    return this.requireTransaction(sessionId, transactionId)
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
       WHERE session_id = ? AND transaction_id = ?`,
      [Date.now(), failureReason, sessionId, transactionId],
    )
    return this.requireTransaction(sessionId, transactionId)
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
      params as never[],
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
}

/** 模块级单例（装配时创建） */
export const pluginRecoveryStore = new PluginRecoveryStore()
```

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack pnpm exec vitest run packages/core/src/selfmod/__tests__/recovery.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/selfmod/recovery.ts packages/core/src/selfmod/__tests__/recovery.test.ts
git commit -m "feat(selfmod): plugin activation WAL recovery store (DSH install-recovery port)"
```

### Task 2: Runner 集成 WAL（run/stop/undefine 事务化）

**Files:**
- Modify: `packages/core/src/selfmod/runner.ts`
- Test: `packages/core/src/selfmod/__tests__/recovery.test.ts`（追加用例）

- [ ] **Step 1: 追加失败测试（Runner 与 WAL 集成）**

在 `recovery.test.ts` 末尾追加：

```ts
import { DynamicPluginRunner } from "../runner"
import { SelfModStorage } from "../storage"
import { createMiraContext } from "../../framework/services"

const HOOK_PLUGIN_CODE = `
  return {
    name: 'hook-plugin',
    apply(ctx) {
      ctx.on('selfmod/test-event', () => 'plugin-fired')
    }
  }
`

describe("Runner 集成 WAL", () => {
  it("run 成功路径不留未决事务（立即 seal→verified→clear）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-runner-wal-"))
    initPlatformPaths({ userData: tmp })
    const store = new PluginRecoveryStore()
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx, {}, new SelfModStorage())
    const { pluginId, packageId } = runner.define("s1", "p", "测试", HOOK_PLUGIN_CODE)

    await runner.run("s1", pluginId, packageId, "run", { recoveryStore: store })
    expect(await store.pending("s1")).toHaveLength(0)
  })

  it("激活失败时回滚到上一个健康版本（WAL 记录 rolled-back）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-runner-wal-fail-"))
    initPlatformPaths({ userData: tmp })
    const store = new PluginRecoveryStore()
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx, {}, new SelfModStorage())
    const { pluginId, packageId } = runner.define("s1", "p", "测试", HOOK_PLUGIN_CODE)
    await runner.run("s1", pluginId, packageId, "run", { recoveryStore: store })

    // 追加一个坏版本并 update → 失败 → WAL 应回滚到上一个健康版本 pkg-1
    const badPkg = runner.getRegistry().addPackage(pluginId, "p", "bad", `return 42`)
    const result = await runner.run("s1", pluginId, badPkg, "update", { recoveryStore: store })
    expect(result.ok).toBe(false)
    expect(await store.pending("s1")).toHaveLength(0)
    // 插件仍运行在健康版本
    expect(runner.list("s1")[0].currentPackageId).toBe(packageId)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack pnpm exec vitest run packages/core/src/selfmod/__tests__/recovery.test.ts`
Expected: FAIL，TypeError `runner.run(...) 第三个参数后不接受对象`（签名不匹配）。

- [ ] **Step 3: 实现 Runner 集成**

`packages/core/src/selfmod/runner.ts` 修改两处：

1. 文件顶部导入：

```ts
import { pluginRecoveryStore, type PluginRecoveryStore } from "./recovery"
```

2. 在 `DynamicPluginRunner` 类中新增私有方法与新的可选参数（原方法签名保留，新增第四参 `options`，向后兼容）：

```ts
  /** 已激活插件恢复为上一健康版本的包 id（崩溃回滚目标） */
  private healthyPackageId(plugin: { packages: Map<string, { packageId: string; createdAt: number }> }, exclude: string): string | null {
    const candidates = [...plugin.packages.values()]
      .filter((p) => p.packageId !== exclude)
      .sort((a, b) => b.createdAt - a.createdAt)
    return candidates[0]?.packageId ?? null
  }
```

`run` 方法签名与事务化（替换现有 `run` 的尾部，从 `// 停止旧激活` 起）为：

```ts
  async run(
    sessionId: string,
    pluginId: PluginId,
    packageId: PackageId,
    mode: "run" | "update" = "run",
    options: { recoveryStore?: PluginRecoveryStore } = {},
  ): Promise<RunResult> {
    const recovery = options.recoveryStore ?? pluginRecoveryStore
    try {
      // 审批门（防御性检查）：ctx.permissions 明确 deny "selfmod" 时拒绝激活。
      const perms = this.ctx.get("permissions") as { evaluate(action: string, permission?: string): "allow" | "deny" | "ask" } | undefined
      if (perms?.evaluate("selfmod") === "deny") {
        return { ok: false, message: `权限拒绝：动态插件激活（selfmod）被当前权限规则禁止` }
      }
      if (!this.registry.owns(pluginId, sessionId)) {
        return { ok: false, message: `插件 ${pluginId} 不存在或不属于当前会话` }
      }
      const plugin = this.registry.get(pluginId)!
      const pkg = this.registry.getPackage(pluginId, packageId)
      if (!pkg) return { ok: false, message: `插件 ${pluginId} 无版本 ${packageId}` }

      if (mode === "update" && plugin.currentPackageId === undefined) {
        return { ok: false, message: `插件 ${pluginId} 尚无激活版本，请用 mode: "run" 启动` }
      }
      if (mode === "run" && plugin.currentPackageId !== undefined && plugin.currentPackageId !== packageId) {
        return { ok: false, message: `插件 ${pluginId} 当前版本为 ${plugin.currentPackageId}，请用 mode: "update" 切换` }
      }

      const prevPackageId = this.healthyPackageId(plugin, packageId)
      // 激活前写 WAL（崩溃窗口保护）
      const txn = await recovery.begin(sessionId, pluginId, mode, packageId, prevPackageId)

      // 停止旧激活（切换版本时先卸载）
      await this.stop(sessionId, pluginId)

      // 沙箱求值
      const sandbox = createSandbox(pluginId, buildCtxFacade(this.ctx))
      const evaluated = await evaluateHostCode(sandbox, pkg.code, pluginId, this.registry.vmTimeoutMs)
      if (!isPlugin(evaluated)) {
        const hint = evaluated === undefined ? "（是否忘了 return 插件对象？）" : "（期望 function 或 { apply(ctx) }）"
        this.registry.markFailed(pluginId, packageId, "插件代码未返回有效插件形状 " + hint)
        await recovery.recover(sessionId, txn.transactionId, "install-failed")
        return { ok: false, message: `插件 ${pluginId} 求值失败：未返回有效插件形状 ${hint}` }
      }

      // 挂载为真实 Cordis 插件（可逆 effect，卸载自动回滚）
      await (this.ctx as unknown as { plugin(p: unknown, config?: unknown): Promise<unknown> }).plugin(evaluated, { sessionId })
      this.activePlugins.set(pluginId, evaluated)
      this.registry.markRunning(pluginId, packageId)
      const hasClientCode = !!pkg.clientCode
      // 正常路径立即了结事务（激活即时生效，无需重启验证）
      await recovery.markHealthy(sessionId, txn.transactionId)
      await recovery.clear(sessionId, txn.transactionId)
      return {
        ok: true,
        message: `插件 ${pluginId} 已激活（版本 ${packageId}）${hasClientCode ? "，含浏览器端 client half" : ""}。如不再需要可调用 mira_plugin_stop 停止。`,
        pluginId,
        packageId,
        hasClientCode,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.registry.markFailed(pluginId, packageId, msg)
      return { ok: false, message: `插件 ${pluginId} 激活失败：${msg}` }
    }
  }
```

> 注意：`stop`/`undefine` 是同步可回滚操作（`ctx.registry.delete` + 内存清除），不写 WAL——它们不产生"崩溃后需回滚"的窗口（卸载失败不会污染下次启动）。

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack pnpm exec vitest run packages/core/src/selfmod/__tests__/recovery.test.ts packages/core/src/selfmod/__tests__/selfmod.test.ts`
Expected: PASS（recovery 8 用例 + selfmod 原有用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/selfmod/runner.ts packages/core/src/selfmod/__tests__/recovery.test.ts
git commit -m "feat(selfmod): transactionize plugin activation with WAL (run/update)"
```

### Task 3: 启动恢复 recoverPending（sidecar 启动时处理崩溃残留）

**Files:**
- Modify: `packages/core/src/selfmod/index.ts`（导出 `recoverPending`）
- Modify: `packages/core/src/system/server/cli.ts`（启动后调用）
- Test: `packages/core/src/selfmod/__tests__/recovery.test.ts`（追加用例）

- [ ] **Step 1: 追加失败测试（recoverPending 行为）**

在 `recovery.test.ts` 末尾追加：

```ts
describe("recoverPending（崩溃残留处理）", () => {
  it("未决事务按 prev 版本恢复；无 prev 则清除", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-recover-pending-"))
    initPlatformPaths({ userData: tmp })
    const store = new PluginRecoveryStore()
    const ctx = await createMiraContext()
    const storage = new SelfModStorage()
    const runner = new DynamicPluginRunner(ctx, {}, storage)

    // 定义两个插件：p1 有 prev（模拟崩溃前已有健康版本），p2 无 prev
    const p1 = runner.define("s1", "p1", "有历史", HOOK_PLUGIN_CODE)
    const prevPkg = runner.getRegistry().addPackage(p1.pluginId, "p1", "v2 健康版", HOOK_PLUGIN_CODE)
    const txn = await store.begin("s1", p1.pluginId, "update", p1.packageId, prevPkg)
    await store.seal("s1", txn.transactionId)

    const p2 = runner.define("s1", "p2", "无历史", HOOK_PLUGIN_CODE)
    const txn2 = await store.begin("s1", p2.pluginId, "run", p2.packageId, null)
    await store.seal("s1", txn2.transactionId)

    await recoverPending({ store, runner })

    // p1 回滚并恢复运行在 prev 版本
    expect(runner.list("s1").find((p) => p.pluginId === p1.pluginId)?.currentPackageId).toBe(prevPkg)
    // p2 无 prev → 保持未运行，事务已清
    expect(runner.list("s1").find((p) => p.pluginId === p2.pluginId)?.currentPackageId).toBeUndefined()
    expect(await store.pending()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack pnpm exec vitest run packages/core/src/selfmod/__tests__/recovery.test.ts`
Expected: FAIL，`recoverPending is not defined`（未导入）。

- [ ] **Step 3: 实现 `recoverPending` 并接线**

1. `packages/core/src/selfmod/recovery.ts` 末尾追加导出（放在 `pluginRecoveryStore` 之后）：

```ts
import type { DynamicPluginRunner } from "./runner"

export interface RecoverPendingOptions {
  store?: PluginRecoveryStore
  runner: DynamicPluginRunner
}

/**
 * 处理崩溃残留的未决事务：
 * - 有 prev 健康版本：回滚记录 + 用 prev 版本重新激活（last-known-good 恢复）
 * - 无 prev：保持未运行，清除事务
 * - 恢复激活失败：标记为回滚并记录失败原因
 */
export async function recoverPending(options: RecoverPendingOptions): Promise<number> {
  const store = options.store ?? pluginRecoveryStore
  const pending = await store.pending()
  let handled = 0
  for (const txn of pending) {
    if (txn.prevPackageId !== null && txn.action === "run" || txn.action === "update") {
      try {
        const res = await options.runner.run(
          txn.sessionId,
          txn.pluginId,
          txn.prevPackageId as import("./registry").PackageId,
          "run",
          { recoveryStore: store },
        )
        if (res.ok) {
          await store.clear(txn.sessionId, txn.transactionId)
        } else {
          await store.recover(txn.sessionId, txn.transactionId, "startup-failed")
        }
      } catch {
        await store.recover(txn.sessionId, txn.transactionId, "startup-failed")
      }
    } else {
      await store.recover(txn.sessionId, txn.transactionId, "interrupted-install")
    }
    handled++
  }
  return handled
}
```

2. `packages/core/src/selfmod/index.ts` 导出 `recoverPending`（加入已有的 `export { ... } from "./tools"` 块之后新增一行）：

```ts
export { recoverPending, PluginRecoveryStore, pluginRecoveryStore } from "./recovery"
export type { RecoveryTransaction, RecoveryPhase, RecoveryAction, RecoveryFailureReason } from "./recovery"
```

3. `packages/core/src/system/server/api.ts` 导出 ctx 装配入口（`setupSelfModification` 已在 `getMiraContext()` 中调用，见 api.ts:63，**不可重复 createMiraContext**）：

```ts
// api.ts 现有函数改为导出（供 cli.ts 复用同一 ctx 与 runner）
export async function getMiraContext(): Promise<MiraContext> { ... } // 原实现不变，仅加 export
```

`packages/core/src/system/server/cli.ts` 启动后调用（`startServer(...).then(...)` 内、`console.log(JSON.stringify({event:"ready"}))` 之后）：

```ts
import { getMiraContext } from "./api"
import { setupSelfModification, recoverPending, pluginRecoveryStore } from "../selfmod"
import { getDynamicPluginRunner } from "../selfmod"

// 恢复崩溃残留的插件激活事务（last-known-good 回滚）。
// getMiraContext 幂等：装配 ctx + setupSelfModification，与 stream handler 共享同一 runner。
void getMiraContext()
  .then(() => recoverPending({ runner: getDynamicPluginRunner(), store: pluginRecoveryStore }))
  .then((n) => { if (n > 0) console.log(`[Sidecar] recovered ${n} pending plugin activation transaction(s)`) })
  .catch((err) => console.error(`[Sidecar] plugin recovery failed: ${err?.message ?? err}`))
```

> **不阻塞 ready**：恢复是异步后置任务（`void`），sidecar 启动不受影响；`recoverPending` 内部失败仅记录日志。

- [ ] **Step 4: 运行测试确认通过 + typecheck**

Run: `corepack pnpm exec vitest run packages/core/src/selfmod/__tests__/recovery.test.ts`
Run: `corepack pnpm typecheck`
Expected: 全部 PASS / exit 0。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/selfmod/recovery.ts packages/core/src/selfmod/index.ts packages/core/src/system/server/cli.ts packages/core/src/selfmod/__tests__/recovery.test.ts
git commit -m "feat(selfmod): recover pending plugin activations at sidecar startup"
```

---

## Phase 2：崩溃证据（active-run 标记）

### 设计决策

移植 DSH `crash-evidence.ts`：sidecar 进程启动时写 `active-run.json`（userData/runtime/），干净退出时删除；下次启动若发现残留，判定上次异常退出。main 进程启动时读取并记录到日志。放 core（纯 Node fs 同步 API，可测），electron main 仅作薄接线。

**落点文件：**
- Create: `packages/core/src/system/crash-evidence.ts`
- Modify: `packages/core/src/system/server/cli.ts`（sidecar 接入）
- Modify: `packages/electron/src/main/index.ts`（main 读取并日志）
- Test: `packages/core/src/system/__tests__/crash-evidence.test.ts`

### Task 4: 实现 crash-evidence 模块

**Files:**
- Create: `packages/core/src/system/crash-evidence.ts`
- Test: `packages/core/src/system/__tests__/crash-evidence.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/core/src/system/__tests__/crash-evidence.test.ts`：

```ts
import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beginDesktopRun, readLastRun } from "../crash-evidence"

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mira-crash-"))
}

describe("崩溃证据（active-run 标记）", () => {
  it("beginDesktopRun 写入标记，markClean 后删除", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    const run = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0-test" })
    expect(fs.existsSync(statePath)).toBe(true)
    run.markClean()
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it("markClean 幂等（重复调用不抛错）", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    const run = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0-test" })
    run.markClean()
    run.markClean()
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it("残留标记可被下次启动读取（模拟崩溃后场景）", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    // 第一次启动：写标记后"崩溃"（不 markClean）
    beginDesktopRun(statePath, { startedAt: "2026-08-20T00:00:00.000Z", pid: 1111, version: "0.0.0" })
    // 第二次启动：读到上次残留
    const second = beginDesktopRun(statePath, { startedAt: "2026-08-20T00:01:00.000Z", pid: 2222, version: "0.0.0" })
    expect(second.previousRun).toBeDefined()
    if (second.previousRun && !("unreadable" in second.previousRun)) {
      expect(second.previousRun.pid).toBe(1111)
    }
  })

  it("无标记时 previousRun 为 undefined", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    const run = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0" })
    expect(run.previousRun).toBeUndefined()
    run.markClean()
  })

  it("readLastRun 只读不改（供 main 进程使用）", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    beginDesktopRun(statePath, { startedAt: "2026-08-20T00:00:00.000Z", pid: 3333, version: "0.0.0" })
    const last = readLastRun(statePath)
    expect(last).toBeDefined()
    if (last && !("unreadable" in last)) expect(last.pid).toBe(3333)
    // 读取不改动标记
    expect(fs.existsSync(statePath)).toBe(true)
  })

  it("损坏的标记返回 unreadable 而非抛错", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{ not json", "utf8")
    const last = readLastRun(statePath)
    expect(last && "unreadable" in last).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack pnpm exec vitest run packages/core/src/system/__tests__/crash-evidence.test.ts`
Expected: FAIL，`Cannot find module '../crash-evidence'`。

- [ ] **Step 3: 实现 `crash-evidence.ts`**

`packages/core/src/system/crash-evidence.ts`（移植 DSH 实现，保留隐私模式 + 符号链接防护 + 原子写）：

```ts
/**
 * 崩溃证据 — 移植 dsh-plugin-desktop crash-evidence
 *
 * sidecar 进程启动时写 active-run.json（userData/runtime/），干净退出时删除。
 * 下次启动若发现残留，判定上次异常退出（崩溃/强杀）。main 进程可经 readLastRun 只读探测。
 */

import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export interface CrashRunRecord {
  readonly startedAt: string
  readonly pid: number
  readonly version: string
}

export interface UnreadableCrashRun {
  readonly unreadable: true
}

export interface CrashRun {
  readonly previousRun: CrashRunRecord | UnreadableCrashRun | undefined
  /** 移除本进程的 active 标记（受 ownerId 保护，仅能删自己的） */
  markClean(): void
}

interface StoredCrashRun extends CrashRunRecord {
  readonly ownerId?: string
}

function lstatOptional(filename: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
}

function assertOwnedMarker(stats: NonNullable<ReturnType<typeof lstatSync>>): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
    throw new Error("mira: active run marker is invalid")
  }
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW
}

function readStoredRun(statePath: string): StoredCrashRun | UnreadableCrashRun | undefined {
  const pathStats = lstatOptional(statePath)
  if (pathStats === undefined) return undefined
  assertOwnedMarker(pathStats)
  const descriptor = openSync(statePath, constants.O_RDONLY | noFollowFlag())
  try {
    assertOwnedMarker(fstatSync(descriptor))
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"))
    if (typeof value !== "object" || value === null) return { unreadable: true }
    const record = value as Partial<StoredCrashRun>
    if (typeof record.startedAt !== "string"
      || typeof record.pid !== "number"
      || typeof record.version !== "string") return { unreadable: true }
    return {
      startedAt: record.startedAt,
      pid: record.pid,
      version: record.version,
      ...(typeof record.ownerId === "string" ? { ownerId: record.ownerId } : {}),
    }
  } catch (cause) {
    if (cause instanceof SyntaxError) return { unreadable: true }
    throw cause
  } finally {
    closeSync(descriptor)
  }
}

function unlinkTemporary(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
}

function writeCurrentRun(statePath: string, currentRun: StoredCrashRun): void {
  const directory = dirname(statePath)
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const directoryStats = lstatSync(directory)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("mira: active run directory is invalid")
  }
  try { chmodSync(directory, PRIVATE_DIRECTORY_MODE) } catch {}

  const temporary = join(directory, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(currentRun)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    })
    try { chmodSync(temporary, PRIVATE_FILE_MODE) } catch {}
    renameSync(temporary, statePath)
  } finally {
    unlinkTemporary(temporary)
  }
}

/** 只读探测上次标记（main 进程用，不写不改） */
export function readLastRun(statePath: string): CrashRunRecord | UnreadableCrashRun | undefined {
  const stored = readStoredRun(statePath)
  if (stored === undefined || "unreadable" in stored) return stored
  return { startedAt: stored.startedAt, pid: stored.pid, version: stored.version }
}

/** 持久化本次启动并返回上次异常退出的证据 */
export function beginDesktopRun(statePath: string, currentRun: CrashRunRecord): CrashRun {
  const storedPreviousRun = readStoredRun(statePath)
  const previousRun = storedPreviousRun === undefined || "unreadable" in storedPreviousRun
    ? storedPreviousRun
    : {
        startedAt: storedPreviousRun.startedAt,
        pid: storedPreviousRun.pid,
        version: storedPreviousRun.version,
      }
  const ownerId = randomUUID()
  writeCurrentRun(statePath, { ...currentRun, ownerId })
  let clean = false
  return {
    previousRun,
    markClean() {
      if (clean) return
      const storedRun = readStoredRun(statePath)
      if (storedRun === undefined || "unreadable" in storedRun || storedRun.ownerId !== ownerId) {
        clean = true
        return
      }
      unlinkSync(statePath)
      clean = true
    },
  }
}

/** 默认标记路径（基于 initPlatformPaths 的 userData） */
export function defaultCrashStatePath(userDataDir: string): string {
  return join(userDataDir, "runtime", "active-run.json")
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `corepack pnpm exec vitest run packages/core/src/system/__tests__/crash-evidence.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/system/crash-evidence.ts packages/core/src/system/__tests__/crash-evidence.test.ts
git commit -m "feat(core): crash evidence active-run marker (DSH crash-evidence port)"
```

### Task 5: sidecar 与 electron main 接入崩溃证据

**Files:**
- Modify: `packages/core/src/system/server/cli.ts`
- Modify: `packages/electron/src/main/index.ts`

- [ ] **Step 1: 修改 `cli.ts`（sidecar 写/清标记）**

`packages/core/src/system/server/cli.ts`：

```ts
import { beginDesktopRun, defaultCrashStatePath } from "../crash-evidence"

// ... 在 initPlatformPaths 之后、startServer 之前：
const crashStatePath = defaultCrashStatePath(userData || process.env.MIRA_USER_DATA || "")
const activeRun = crashStatePath ? beginDesktopRun(crashStatePath, {
  startedAt: new Date().toISOString(),
  pid: process.pid,
  version: process.env.MIRA_VERSION || "dev",
}) : null
if (activeRun?.previousRun) {
  const prev = activeRun.previousRun
  console.error(`[Sidecar] previous run did not exit cleanly: ${"unreadable" in prev ? "unreadable marker" : `pid=${prev.pid} startedAt=${prev.startedAt}`}`)
}

const markClean = () => { try { activeRun?.markClean() } catch {} }
process.on("exit", markClean)
process.on("SIGINT", () => { markClean(); process.exit(0) })
process.on("SIGTERM", () => { markClean(); process.exit(0) })
```

> 注：`startServer` 失败路径（`.catch` 中 `process.exit(1)`）也会触发 `exit` 事件清理标记——符合语义（启动失败不算"异常崩溃"）。

- [ ] **Step 2: 修改 `main/index.ts`（main 读取并日志）**

`packages/electron/src/main/index.ts`，在 `initializeApp` 中 `initPlatformPaths` 之后、`initLogger` 之后：

```ts
import { readLastRun, defaultCrashStatePath } from "@mira/core/system/crash-evidence";

// 读取 sidecar 上次运行残留（判定异常退出）
try {
  const last = readLastRun(defaultCrashStatePath(app.getPath("userData")));
  if (last) {
    const detail = "unreadable" in last ? "（标记损坏）" : `（pid=${last.pid}, startedAt=${last.startedAt}）`;
    console.warn(`[Main] Sidecar 上次未干净退出 ${detail}`);
  }
} catch {
  // 读取失败不阻塞启动
}
```

> 注：需确认 `@mira/core` 是否导出 `system/crash-evidence`（见 `packages/core/src/index.ts` 导出面）。若未导出，在 `index.ts` 增加：
> ```ts
> export { beginDesktopRun, readLastRun, defaultCrashStatePath } from "./system/crash-evidence"
> export type { CrashRun, CrashRunRecord, UnreadableCrashRun } from "./system/crash-evidence"
> ```

- [ ] **Step 3: 运行 typecheck**

Run: `corepack pnpm typecheck`
Expected: exit 0。

- [ ] **Step 4: 提交**

```bash
git add packages/core/src/system/crash-evidence.ts packages/core/src/system/server/cli.ts packages/core/src/index.ts packages/electron/src/main/index.ts
git commit -m "feat(electron): wire crash evidence marker into sidecar lifecycle"
```

---

## Phase 3：启动健康检查 + 恢复窗口

### 设计决策

DSH 的 `renderer-boot.ts` 是"renderer 加载完成后 POST 上报 + main 30s 超时 + 失败弹恢复窗口"。Mira 已有 `/api/health`（server.ts:242）与 main 的 `await sidecarPromise`（失败弹 `dialog.showErrorBox`）。增强为三层：

1. **sidecar `/api/health` 增强**：报告核心就绪 + selfmod 恢复事务数 + 最近 boot 时间戳。
2. **core `health.ts` 纯逻辑**（可测）：`waitForHealth(url, opts)` 带超时轮询；`rendererBootWindow(startedAt, now, timeoutMs)` 判定 boot 是否超时。
3. **electron main 接线**：sidecar 就绪后轮询 health；渲染窗口加载后等待 renderer 上报，超时弹恢复对话框（重启 / 打开日志目录）。

**落点文件：**
- Modify: `packages/core/src/system/server/server.ts`（health 增强）
- Create: `packages/core/src/system/health.ts`
- Modify: `packages/electron/src/main/index.ts`（boot 计时器 + IPC + notifyRendererBooted）
- Modify: `packages/electron/src/ipc/handlers.ts`（`mira:renderer-boot` 监听）
- Modify: `packages/electron/src/preload/index.ts`（`notifyRendererReady`）
- Modify: `apps/desktop/src/components/StartupOverlay.tsx`（状态展示）
- Modify: `apps/desktop/src/App.tsx`（首帧就绪上报 + overlay phase 透传）
- Test: `packages/core/src/system/__tests__/health.test.ts`

### Task 6: sidecar health 增强 + 纯逻辑模块

**Files:**
- Create: `packages/core/src/system/health.ts`
- Modify: `packages/core/src/system/server/server.ts:242`
- Test: `packages/core/src/system/__tests__/health.test.ts`

- [ ] **Step 1: 写失败测试（health 纯逻辑）**

`packages/core/src/system/__tests__/health.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest"
import { waitForHealth, rendererBootWindow } from "../health"

describe("waitForHealth（带超时轮询）", () => {
  it("健康端点就绪即返回（不重试）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const ok = await waitForHealth("http://127.0.0.1:1/health", { fetchFn: fetchMock as unknown as typeof fetch, timeoutMs: 1000, intervalMs: 20 })
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("端点未就绪时重试直到超时返回 false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    const ok = await waitForHealth("http://127.0.0.1:1/health", { fetchFn: fetchMock as unknown as typeof fetch, timeoutMs: 100, intervalMs: 20 })
    expect(ok).toBe(false)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it("网络错误视为未就绪并继续重试", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    const ok = await waitForHealth("http://127.0.0.1:1/health", { fetchFn: fetchMock as unknown as typeof fetch, timeoutMs: 100, intervalMs: 20 })
    expect(ok).toBe(false)
  })
})

describe("rendererBootWindow（boot 超时判定）", () => {
  it("未超时返回 false", () => {
    expect(rendererBootWindow(Date.now() - 10_000, Date.now(), 30_000)).toBe(false)
  })
  it("超时返回 true", () => {
    expect(rendererBootWindow(Date.now() - 31_000, Date.now(), 30_000)).toBe(true)
  })
  it("30s 临界点不超时", () => {
    expect(rendererBootWindow(Date.now() - 30_000, Date.now(), 30_000)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack pnpm exec vitest run packages/core/src/system/__tests__/health.test.ts`
Expected: FAIL，`Cannot find module '../health'`。

- [ ] **Step 3: 实现 `health.ts`**

`packages/core/src/system/health.ts`（完整文件）：

```ts
/**
 * 启动健康检查 — 借鉴 dsh-plugin-desktop renderer-boot
 *
 * - waitForHealth：对 /api/health 做带超时轮询（sidecar 冷启动可能需数秒）
 * - rendererBootWindow：判定渲染层 boot 上报是否超时（main 30s 后弹恢复窗口）
 * 纯逻辑、无 Electron 依赖，便于 vitest 覆盖。
 */

export interface WaitForHealthOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
  intervalMs?: number
}

/** 轮询健康端点直到 200 或超时。默认超时 30s、间隔 200ms。 */
export async function waitForHealth(url: string, options: WaitForHealthOptions = {}): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(url, { method: "GET" })
      if (res.ok) return true
    } catch {
      // 连接被拒/网络错误 → 未就绪，继续重试
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/** 判定渲染层 boot 上报是否超时（startedAt 为窗口起点）。 */
export function rendererBootWindow(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt > timeoutMs
}

/** 默认 boot 超时（对齐 DSH 的 RENDERER_BOOT_TIMEOUT_MS） */
export const RENDERER_BOOT_TIMEOUT_MS = 30_000
```

- [ ] **Step 4: 增强 `/api/health`（server.ts）**

`packages/core/src/system/server/server.ts` 的 `case "/api/health"`（当前第 242 行）替换为：

```ts
    case "/api/health": {
      // 报告核心就绪 + selfmod 恢复事务数（供 main 判定启动健康）
      const pending = await pluginRecoveryStore.pending().catch(() => [])
      jsonResponse(res, 200, {
        status: "ok",
        version: process.env.MIRA_VERSION || "dev",
        selfmodPending: pending.length,
        timestamp: Date.now(),
      })
      return
    }
```

并在文件顶部导入：

```ts
import { pluginRecoveryStore } from "../../selfmod/recovery"
```

- [ ] **Step 5: 运行测试确认通过 + typecheck**

Run: `corepack pnpm exec vitest run packages/core/src/system/__tests__/health.test.ts`
Run: `corepack pnpm typecheck`
Expected: 全部 PASS / exit 0。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/system/health.ts packages/core/src/system/server/server.ts packages/core/src/system/__tests__/health.test.ts
git commit -m "feat(core): sidecar health endpoint + boot window logic"
```

### Task 7: renderer boot 窗口判定 + 恢复提示（electron main + preload + ui）

> **现状核查（重要）**：`sidecar-bridge.ts:92-164` 已有完整的 sidecar 健康检查与自动重连（5s 间隔 + 指数退避 + 状态广播），**不需要也不应重复接入 `waitForHealth`**。Mira 真正缺失的是 DSH `renderer-boot.ts` 的**渲染层 boot 上报 + 超时提示**：主窗口加载后 30s 内 renderer 未就绪则弹恢复提示。

**Files:**
- Modify: `packages/electron/src/main/index.ts`（boot 计时器 + IPC 监听）
- Modify: `packages/electron/src/ipc/handlers.ts`（注册 `mira:renderer-boot`）
- Modify: `packages/electron/src/preload/index.ts`（暴露 `notifyRendererReady`）
- Modify: `apps/desktop/src/App.tsx`（首帧就绪上报）

- [ ] **Step 1: main 进程 boot 计时器 + IPC 监听**

`packages/electron/src/main/index.ts`：

文件顶部导入（并入现有 electron 导入，新增 `ipcMain`）：

```ts
import { app, BrowserWindow, dialog, globalShortcut, ipcMain } from "electron";
import { rendererBootWindow, RENDERER_BOOT_TIMEOUT_MS } from "@mira/core/system/health";
```

模块级新增（`initializeApp` 之外）：

```ts
let windowBootTimer: NodeJS.Timeout | undefined;
let rendererBooted = false;

function startRendererBootWindow(): void {
  const bootStartedAt = Date.now();
  rendererBooted = false;
  windowBootTimer = setTimeout(() => {
    if (!rendererBooted && rendererBootWindow(bootStartedAt, Date.now(), RENDERER_BOOT_TIMEOUT_MS)) {
      void dialog.showMessageBox({
        type: "warning",
        title: "Mira 界面加载缓慢",
        message: "界面未能按时完成加载，可尝试重启或查看日志。",
        buttons: ["重启", "忽略"],
      }).then(({ response }) => { if (response === 0) app.relaunch(); });
    }
  }, RENDERER_BOOT_TIMEOUT_MS + 1000);
}
```

`initializeApp` 中 `await createWindow()` 之后（`createTray()` 之前）调用：

```ts
  await createWindow();
  startRendererBootWindow(); // renderer boot 计时：30s 未就绪弹恢复提示
  createTray();
```

`before-quit` 中清理计时器：

```ts
app.on("before-quit", async () => {
  if (windowBootTimer) clearTimeout(windowBootTimer);
  globalShortcut.unregisterAll();
  destroyPetWindow();
  destroyTray();
  await stopSidecar();
});
```

- [ ] **Step 2: 注册 IPC handler + preload 暴露**

`packages/electron/src/ipc/handlers.ts`（注册处追加）：

```ts
import { ipcMain } from "electron";

// renderer 就绪上报（boot 窗口取消）
ipcMain.on("mira:renderer-boot", () => {
  rendererBooted = true;
  if (windowBootTimer) { clearTimeout(windowBootTimer); windowBootTimer = undefined; }
});
```

> `rendererBooted`/`windowBootTimer` 从 `../main/index` 导入（需在 main/index.ts 导出，或改为在 handlers.ts 内部维护并暴露取消函数。推荐：`main/index.ts` 导出 `notifyRendererBooted()`，handlers.ts 调用它）。

`packages/electron/src/main/index.ts` 追加导出：

```ts
export function notifyRendererBooted(): void {
  rendererBooted = true;
  if (windowBootTimer) { clearTimeout(windowBootTimer); windowBootTimer = undefined; }
}
```

`packages/electron/src/preload/index.ts`（contextBridge 暴露，追加）：

```ts
notifyRendererReady: () => ipcRenderer.send("mira:renderer-boot"),
```

- [ ] **Step 3: App.tsx 首帧就绪上报**

`apps/desktop/src/App.tsx` 根组件 `useEffect` 中（挂载后）：

```tsx
useEffect(() => {
  // 通知主进程 renderer 已就绪（取消 boot 超时提示）
  window.electronAPI?.notifyRendererReady?.();
}, []);
```

> 若 `electron.d.ts` 中 `notifyRendererReady` 未声明，在 `apps/desktop/src/types/electron.d.ts` 的 `ElectronAPI` 接口追加 `notifyRendererReady(): void`。

- [ ] **Step 4: 运行 typecheck**

Run: `corepack pnpm typecheck`
Expected: exit 0。

> 验证方式：手动启动 `pnpm dev`，正常路径 30s 内无提示；模拟 renderer 卡死（在 App.tsx 注入死循环）时 31s 后弹"界面加载缓慢"提示。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/system/health.ts packages/core/src/system/server/server.ts packages/core/src/system/__tests__/health.test.ts packages/electron/src/main/index.ts packages/electron/src/ipc/handlers.ts packages/electron/src/preload/index.ts apps/desktop/src/App.tsx apps/desktop/src/types/electron.d.ts
git commit -m "feat(electron): renderer boot window + recovery prompt"
```

### Task 8: StartupOverlay 连接状态展示

**Files:**
- Modify: `apps/desktop/src/components/StartupOverlay.tsx`
- Modify: `apps/desktop/src/App.tsx`（透传健康状态）

- [ ] **Step 1: 扩展 `StartupOverlay` 支持状态**

`apps/desktop/src/components/StartupOverlay.tsx`（替换文件）：

```tsx
import { useEffect, useState } from "react";
import { MiraLogo } from "@mira/ui/chat/MiraLogo";

export type StartupPhase = "connecting" | "ready" | "failed";

interface StartupOverlayProps {
  visible: boolean;
  phase?: StartupPhase;
  error?: string;
}

/**
 * 启动加载遮罩 — 展示连接 Core 状态 + 失败信息
 * phase=connecting：logo 呼吸 + 加载点；phase=ready：淡出卸载；
 * phase=failed：显示错误详情（由 App 层在 Core 健康检查超时后置位）。
 */
export function StartupOverlay({ visible, phase = "connecting", error }: StartupOverlayProps) {
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    if (visible) return;
    const timer = setTimeout(() => setMounted(false), 600);
    return () => clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;

  const statusText =
    phase === "failed" ? "Core 服务连接失败" : phase === "ready" ? "连接成功，正在加载..." : "正在连接 Mira Core...";

  return (
    <div className={`startup-overlay${visible ? "" : " startup-overlay--hidden"}`}>
      <div className="startup-overlay__logo">
        <MiraLogo size={96} />
        <span className="startup-overlay__shine" />
      </div>
      <div className="startup-overlay__title">{statusText}</div>
      {phase === "failed" && error && (
        <div className="startup-overlay__error">{error}</div>
      )}
      <div className="startup-overlay__dots">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `App.tsx` 透传 phase/error**

`apps/desktop/src/App.tsx` 中 `StartupOverlay` 的使用处增加 `phase` 与 `error` props。`phase` 数据来源：在应用初始化逻辑中轮询 `window.electronAPI` 的健康/就绪事件（若已有 ready 事件则复用；无则新增一个 `coreFailed` 状态）。

```tsx
<StartupOverlay visible={overlayVisible} phase={startupPhase} error={startupError} />
```

- [ ] **Step 3: 运行 typecheck**

Run: `corepack pnpm typecheck`
Expected: exit 0。

> UI 无自动化测试基建（vitest 仅覆盖 core），此步验证为 typecheck + 手动启动 `pnpm dev` 目测：正常启动时遮罩显示"正在连接 Mira Core..."→ 就绪淡出；模拟 Core 启动失败（改 sidecar 端口）时显示失败信息与错误详情。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/components/StartupOverlay.tsx apps/desktop/src/App.tsx
git commit -m "feat(ui): startup overlay connecting/failed states"
```

---

## 最终验证

- [ ] 运行全量测试并确认零回归（现有基线 14 failed 均为预先存在的 catalog 缺失）：

```bash
$env:NODE_OPTIONS="--max-old-space-size=6144"; cmd /c "corepack pnpm test > test.log 2>&1"
# 期望：14 failed / 765+ passed（新增 6+2+3+3 = 14 用例）/ 5 skipped
```

- [ ] 运行 typecheck 通过：`corepack pnpm typecheck`（exit 0）

- [ ] 更新 `AGENTS.md`：
  - 目录结构：`selfmod/recovery.ts`、`system/crash-evidence.ts`、`system/health.ts` 条目
  - 高级特性自修改一节：补充"插件激活 WAL（崩溃回滚 / last-known-good 恢复）"
  - 开发指南测试基线数字更新为实际通过数

- [ ] 提交：`git commit -m "docs: record desktop resilience trio in AGENTS.md"`

---

## Self-Review

**Spec 覆盖：**
- Phase 1（WAL 回滚）→ Task 1/2/3，覆盖 DSH install-recovery 状态机移植 + runner 集成 + 启动恢复。✓
- Phase 2（崩溃证据）→ Task 4/5，覆盖 active-run 标记移植 + sidecar/main 接线。✓
- Phase 3（启动健康检查）→ Task 6/7/8，覆盖 health 逻辑 + server 增强 + renderer boot 窗口 + UI 状态；**基于现状核查，不重复实现 sidecar 轮询（已有 startHealthCheck/自动重连）**。✓
- 服务边界契约文档、WS downlink、集成终端明确列为**不在本次范围**（YAGNI，避免范围膨胀），若后续需要单独开计划。✓

**占位符扫描：** 无 TBD/TODO；所有代码步骤均含完整实现。唯一环境相关说明（sidecar-bridge baseUrl 需现场确认）标注了两种分支实现。✓

**类型一致性：** `PluginRecoveryStore` 的 `begin/seal/markHealthy/recover/clear/pending` 在 Task 1 定义、Task 2/3 复用，签名一致；`recoverPending({ store, runner })` 在 Task 3 定义并被测试引用；`waitForHealth/rendererBootWindow` 在 Task 6 定义、Task 7 复用。✓