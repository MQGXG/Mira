/**
 * Sidecar CLI 入口 — 作为独立进程启动
 * node dist/server/cli.js --port 3456 --token abc123 --userData "path/to/data"
 */

import { startServer } from "./server"
import { ensureSharedMemoryFTS, getMiraContext } from "./api"
import { initPlatformPaths } from "../../config/paths"
import { registerDefaultInvariants } from "../../invariants"
import { recoverPending, pluginRecoveryStore, getDynamicPluginRunner } from "../../selfmod"
import { beginDesktopRun, defaultCrashStatePath } from "../crash-evidence"
import type { CrashRun } from "../crash-evidence"

const args = process.argv.slice(2)
const portIdx = args.indexOf("--port")
const tokenIdx = args.indexOf("--token")
const userDataIdx = args.indexOf("--userData")
const modelDirIdx = args.indexOf("--modelDir")

const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) : 3456
const authToken = tokenIdx >= 0 ? args[tokenIdx + 1] : undefined
const userData = userDataIdx >= 0 ? args[userDataIdx + 1] : process.env.MIRA_USER_DATA || ""
const modelDir = modelDirIdx >= 0 ? args[modelDirIdx + 1] : process.env.MIRA_MODEL_DIR || ""

if (userData || modelDir) {
  initPlatformPaths({ userData, home: process.env.HOME || process.env.USERPROFILE || "/tmp", modelDir })
}

// 崩溃证据：写 active-run.json 标记本次启动，干净退出（exit/SIGINT/SIGTERM）时删除。
// 下次启动若发现残留，判定上次异常退出（崩溃/强杀）。userData 为空（如手动跑 cli.js）时跳过，
// 避免在 CWD 写残留标记。
const crashStatePath = userData ? defaultCrashStatePath(userData) : null
let activeRun: CrashRun | null = null
try {
  if (crashStatePath) {
    activeRun = beginDesktopRun(crashStatePath, {
      startedAt: new Date().toISOString(),
      pid: process.pid,
      version: process.env.MIRA_VERSION || "dev",
    })
    if (activeRun.previousRun) {
      const prev = activeRun.previousRun
      console.warn(`[Sidecar] previous run did not exit cleanly: ${"unreadable" in prev ? "unreadable marker" : `pid=${prev.pid} startedAt=${prev.startedAt}`}`)
    }
  }
} catch (cause) {
  // 标记写入失败仅警告，不拖垮 sidecar 启动（磁盘满/权限/杀软锁文件等）
  console.warn(`[Sidecar] crash evidence marker failed: ${cause instanceof Error ? cause.message : String(cause)}`)
}

const markClean = () => { try { activeRun?.markClean() } catch { /* 忽略清理失败 */ } }
process.on("exit", markClean)
process.on("SIGINT", () => { markClean(); process.exit(0) })
process.on("SIGTERM", () => { markClean(); process.exit(0) })

console.log(`[Sidecar] Starting @mira/core server on port ${port}...`)

// 注册运行时 invariant（默认关闭，由 "invariants" flag 控制）
registerDefaultInvariants()

// 全局异常保护：防止单个未捕获异常导致整个 Sidecar 进程崩溃（导致 SSE 通道中断/超时）
process.on("uncaughtException", (err) => {
  console.error(`[Sidecar] Uncaught exception (keeping process alive): ${err?.stack || err?.message || String(err)}`)
})
process.on("unhandledRejection", (reason) => {
  console.error(`[Sidecar] Unhandled rejection (keeping process alive): ${reason instanceof Error ? reason.stack : String(reason)}`)
})

startServer({ port, authToken })
  .then(({ port, token }) => {
    // 输出 JSON 供父进程读取
    console.log(JSON.stringify({ event: "ready", port, token }))
    // P4 优化：后台预热共享 FTS 记忆，避免首条消息等待初始化（不阻塞 ready）
    void ensureSharedMemoryFTS().catch(() => {})
    // 恢复崩溃残留的插件激活事务（last-known-good 回滚）。
    // getMiraContext 幂等：装配 ctx + setupSelfModification，与 stream handler 共享同一 runner；
    // 先 restoreFromStorage 恢复插件定义（否则 pending 事务的 pluginId 不在注册表，
    // runner.run 会在 owns() 检查返回 ok:false，last-known-good 重新激活空转），再处理残留。
    void getMiraContext()
      .then(() => {
        const runner = getDynamicPluginRunner()!
        return runner.restoreFromStorage().then(() => recoverPending({ runner, store: pluginRecoveryStore }))
      })
      .then((n) => { if (n > 0) console.log(`[Sidecar] processed ${n} pending plugin activation transaction(s)`) })
      .catch((err) => console.error(`[Sidecar] plugin recovery failed: ${err?.message ?? err}`))
  })
  .catch((err) => {
    console.error(`[Sidecar] Failed to start: ${err.message}`)
    process.exit(1)
  })
