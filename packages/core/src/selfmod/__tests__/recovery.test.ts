import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { initPlatformPaths } from "../../config/paths"
import { PluginRecoveryStore, RECOVERY_PHASES, recoverPending } from "../recovery"
import { DynamicPluginRunner } from "../runner"
import { SelfModStorage } from "../storage"
import { createMiraContext } from "../../framework/services"
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

    const sealed = await store.seal(txn.sessionId, txn.transactionId)
    expect(sealed.phase).toBe("awaiting-restart")

    const verified = await store.markHealthy(txn.sessionId, txn.transactionId)
    expect(verified.phase).toBe("verified")

    await store.clear(txn.sessionId, txn.transactionId)
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
    const rolled = await store.recover(txn.sessionId, txn.transactionId, "startup-failed")
    expect(rolled.phase).toBe("rolled-back")
    expect(rolled.failureReason).toBe("startup-failed")
    expect(rolled.prevPackageId).toBe("pkg-1")
    expect(await store.pending()).toHaveLength(0)
  })

  it("pending 只返回未决事务（prepared/awaiting-restart/verifying/recovery-pending）", async () => {
    const store = await freshStore()
    await store.begin("s1", "dyn-1", "run", "pkg-2", "pkg-1")
    const t2 = await store.begin("s1", "dyn-2", "run", "pkg-1", undefined)
    await store.seal(t2.sessionId, t2.transactionId)
    await store.markHealthy(t2.sessionId, t2.transactionId)
    await store.clear(t2.sessionId, t2.transactionId)

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

  it("非法相位转移抛错（seal 只接受 prepared）", async () => {
    const store = await freshStore()
    const txn = await store.begin("s1", "dyn-1", "run", "pkg-2", "pkg-1")
    await store.seal(txn.sessionId, txn.transactionId)  // prepared → awaiting-restart
    // 已是 awaiting-restart，再 seal 应抛错（WHERE phase IN ('prepared') 不匹配）
    await expect(store.seal(txn.sessionId, txn.transactionId)).rejects.toThrow(/状态非法/)
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
    const { pluginId, packageId } = runner.define("s-wal-ok", "p", "测试", HOOK_PLUGIN_CODE)

    await runner.run("s-wal-ok", pluginId, packageId, "run", { recoveryStore: store })
    expect(await store.pending("s-wal-ok")).toHaveLength(0)
  })

  it("激活失败时回滚到上一个健康版本（WAL 记录 rolled-back）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-runner-wal-fail-"))
    initPlatformPaths({ userData: tmp })
    const store = new PluginRecoveryStore()
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx, {}, new SelfModStorage())
    const { pluginId, packageId } = runner.define("s-wal-fail", "p", "测试", HOOK_PLUGIN_CODE)
    await runner.run("s-wal-fail", pluginId, packageId, "run", { recoveryStore: store })

    // 追加一个坏版本并 update → 失败 → WAL 应回滚到上一个健康版本 pkg-1
    const badPkg = runner.getRegistry().addPackage(pluginId, "p", "bad", `return 42`)
    const result = await runner.run("s-wal-fail", pluginId, badPkg, "update", { recoveryStore: store })
    expect(result.ok).toBe(false)
    expect(await store.pending("s-wal-fail")).toHaveLength(0)
    // 插件未激活坏版本（激活状态标记为 failed，回滚记录已写入 WAL）
    const reg = runner.getRegistry().get(pluginId)!
    expect(reg.run?.status).toBe("failed")
    expect(reg.run?.packageId).toBe(badPkg)
  })
})

describe("recoverPending（崩溃残留处理）", () => {
  it("重启仿真：定义持久化→新 runner 恢复→WAL 残留按 prev 恢复，无 prev 清除", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-recover-pending-"))
    initPlatformPaths({ userData: tmp })
    const store = new PluginRecoveryStore()
    const storage = new SelfModStorage()

    // 第一次运行：定义 p1（含 prev 健康版本）并自动持久化
    const ctx1 = await createMiraContext()
    const runner1 = new DynamicPluginRunner(ctx1, {}, storage)
    const p1 = runner1.define("s1", "p1", "有历史", HOOK_PLUGIN_CODE)
    const prevPkg = runner1.definePackage("s1", p1.pluginId, "p1", "v2 健康版", HOOK_PLUGIN_CODE).packageId
    await new Promise((r) => setTimeout(r, 50)) // 等待异步持久化（fire-and-forget）

    // 重启：新 runner 从 storage 恢复定义（不重新 define，模拟 sidecar 启动 restoreFromStorage）
    const ctx2 = await createMiraContext()
    const runner2 = new DynamicPluginRunner(ctx2, {}, storage)
    expect(await runner2.restoreFromStorage("s1")).toBeGreaterThanOrEqual(1)

    // 崩溃残留：p1 升级事务（有 prev），p2 首次运行事务（无 prev）
    const txn = await store.begin("s1", p1.pluginId, "update", p1.packageId, prevPkg)
    await store.seal("s1", txn.transactionId)

    const p2 = runner2.define("s1", "p2", "无历史", HOOK_PLUGIN_CODE)
    const txn2 = await store.begin("s1", p2.pluginId, "run", p2.packageId, null)
    await store.seal("s1", txn2.transactionId)

    await recoverPending({ store, runner: runner2 })

    // p1 回滚并恢复运行在 prev 版本（last-known-good 重新激活真实执行）
    expect(runner2.list("s1").find((p) => p.pluginId === p1.pluginId)?.currentPackageId).toBe(prevPkg)
    // p2 无 prev → 保持未运行，事务已清
    expect(runner2.list("s1").find((p) => p.pluginId === p2.pluginId)?.currentPackageId).toBeUndefined()
    expect(await store.pending()).toHaveLength(0)
  })

  it("单事务失败不中断循环（prev 指向坏版本 + 健康事务均处理完）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-recover-cont-"))
    initPlatformPaths({ userData: tmp })
    const store = new PluginRecoveryStore()
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx, {}, new SelfModStorage())

    // p1：prev 指向坏版本 → recoverPending 重新激活返回 ok:false（且 runner.run 的 begin 已覆盖原事务，
    // 之后 recoverPending 对原 transactionId 的 recover 会抛"状态非法"并被吞掉）
    const p1 = runner.define("s1", "p1", "有历史", HOOK_PLUGIN_CODE)
    const badPrev = runner.getRegistry().addPackage(p1.pluginId, "p1", "坏版本", `return 42`)
    const t1 = await store.begin("s1", p1.pluginId, "update", p1.packageId, badPrev)
    await store.seal("s1", t1.transactionId)

    // p2：健康事务（无 prev），created_at 晚于 p1 → 在 p1 之后处理
    const p2 = runner.define("s1", "p2", "无历史", HOOK_PLUGIN_CODE)
    const t2 = await store.begin("s1", p2.pluginId, "run", p2.packageId, null)
    await store.seal("s1", t2.transactionId)

    await recoverPending({ store, runner })

    // p1 激活失败（run 返回 ok:false，run.status 标记 failed），p2 无 prev 保持未运行
    expect(runner.list("s1").find((p) => p.pluginId === p1.pluginId)?.currentPackageId).toBeUndefined()
    expect(runner.list("s1").find((p) => p.pluginId === p2.pluginId)?.currentPackageId).toBeUndefined()
    // 两条都被处理，未决事务清空（循环未被 p1 的中途异常中断）
    expect(await store.pending()).toHaveLength(0)
  })

  it("启动时清理 verified 孤儿行（markHealthy→clear 间崩溃残留，避免无上限堆积）", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-recover-orphan-"))
    initPlatformPaths({ userData: tmp })
    const store = new PluginRecoveryStore()
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx, {}, new SelfModStorage())

    // 制造 verified 孤儿行：begin→seal→markHealthy 但不 clear（模拟 markHealthy 后崩溃）
    const p = runner.define("s-orphan", "p", "孤儿", HOOK_PLUGIN_CODE)
    const txn = await store.begin("s-orphan", p.pluginId, "run", p.packageId, null)
    await store.seal("s-orphan", txn.transactionId)
    await store.markHealthy("s-orphan", txn.transactionId)
    // verified 不在 pending 查询范围（不会被恢复处理），但残留在表中
    expect(await store.pending()).toHaveLength(0)

    // 启动恢复流程应顺带清除 verified 孤儿行
    await recoverPending({ store, runner })
    const db = await getDbAsync()
    const res = db.exec(`SELECT COUNT(*) FROM selfmod_recovery WHERE phase = 'verified'`)
    expect(res[0].values[0][0]).toBe(0)
  })
})
