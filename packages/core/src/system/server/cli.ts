/**
 * Sidecar CLI 入口 — 作为独立进程启动
 * node dist/server/cli.js --port 3456 --token abc123 --userData "path/to/data"
 */

import { startServer } from "./server"
import { ensureSharedMemoryFTS } from "./api"
import { initPlatformPaths } from "../../config/paths"
import { registerDefaultInvariants } from "../../invariants"

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
  })
  .catch((err) => {
    console.error(`[Sidecar] Failed to start: ${err.message}`)
    process.exit(1)
  })
