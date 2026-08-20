/**
 * ServerManager — Sidecar 进程管理器
 * Electron 主进程使用此模块启动和管理 Core HTTP 服务进程
 * 参考 MiMo-Code 的 spawnLocalServer + Sidecar 架构
 */

import type { ChildProcess} from "child_process";
import { spawn } from "child_process"
import * as fs from "fs"
import * as path from "path"
import * as http from "http"

export interface ServerManagerOptions {
  /** Core 包的 server CLI 入口路径 */
  serverEntry?: string
  /** 监听端口（0 = 随机端口） */
  port?: number
  /** 认证 token（未指定则自动生成） */
  authToken?: string
  /** 启动超时（毫秒） */
  timeout?: number
  /** 是否使用 tsx（开发模式） */
  useTsx?: boolean
  /** 数据库路径（主进程 userData） */
  userData?: string
  /** 本地模型资源目录（打包后 resources/models，开发时仓库内 resources/models） */
  modelDir?: string
  /** 应用版本（注入子进程 MIRA_VERSION，供崩溃标记 / /api/health 报告真实版本） */
  version?: string
}

const DEFAULT_OPTIONS: Required<Omit<ServerManagerOptions, "serverEntry">> & { serverEntry: string } = {
  serverEntry: "",
  port: 0,
  authToken: "",
  timeout: 15000,
  useTsx: false,
  userData: "",
  modelDir: "",
  version: "",
}

/** 子进程 spawn env：注入 ELECTRON_RUN_AS_NODE + 可选 MIRA_VERSION（undefined 时不注入，避免写成字面量 "undefined"） */
function spawnEnv(version: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    ...(version ? { MIRA_VERSION: version } : {}),
  }
}

export class ServerManager {
  private process: ChildProcess | null = null
  private resolvedPort = 0
  private resolvedToken = ""
  private resolveReady: ((value: { port: number; token: string }) => void) | null = null
  private rejectReady: ((err: Error) => void) | null = null
  private readyPromise: Promise<{ port: number; token: string }> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private timeout: number

  constructor(private options: ServerManagerOptions = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options }
    if (!merged.serverEntry) {
      // 生产模式：Sidecar 已由 electron-vite 编译为独立的 sidecar.js（与 main.js 同目录）
      merged.serverEntry = path.resolve(__dirname, "sidecar.js")
    }
    this.options = merged
    this.timeout = merged.timeout
  }

  get port(): number { return this.resolvedPort }
  get token(): string { return this.resolvedToken }
  get running(): boolean { return this.process !== null && !this.process.killed }

  /** 启动 Core 服务进程 */
  async start(): Promise<{ port: number; token: string }> {
    // 幂等：若已有存活进程先停止（避免孤儿进程阻塞故障恢复）
    if (this.process) {
      await this.stop()
    }

    // 重置已解析信息，强制 waitForReady 等待新进程的 ready JSON
    //（修复：重建时陈旧端口短路，导致所有请求打向旧端口而永远失败）
    this.resolvedPort = 0
    this.resolvedToken = ""
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject

      this.startupTimer = setTimeout(() => {
        this.resolveReady = null
        this.rejectReady = null
        reject(new Error("Server startup timed out"))
      }, this.timeout)
    })

    const opts = this.options as Required<ServerManagerOptions>

    // 从项目根目录解析 server CLI 路径（兼容 dev 和 prod 两种运行场景）
    const projectRoot = process.env.INIT_CWD || process.cwd()
    const entry = opts.useTsx
      ? path.join(projectRoot, "packages/core/src/system/server/cli.ts")
      : opts.serverEntry

    const baseArgs = ["--port", String(this.options.port || 0)]
    if (this.options.userData) {
      baseArgs.push("--userData", this.options.userData)
    }
    if (this.options.modelDir) {
      baseArgs.push("--modelDir", this.options.modelDir)
    }

    // 打包后的独立子进程无法读取 app.asar 内的文件。
    // 生产模式（非 tsx）用 Electron 自身二进制以 ELECTRON_RUN_AS_NODE=1 运行，保留 asar 读取能力。
    const isPackaged = !opts.useTsx && !!process.versions.electron
    if (isPackaged) {
      this.process = spawn(process.execPath, [entry, ...baseArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        env: spawnEnv(opts.version),
        shell: false,
        windowsHide: true,
      })
      console.log(`[Sidecar] Spawning (electron-as-node): ${process.execPath} ${entry} ${baseArgs.join(" ")}`)
      this.attachProcessListeners()
      return this.waitForReady()
    }

    // 开发模式：优先直启 node + tsx CLI（shell:false，子进程即真实 node server，
    // kill 有效且无 cmd 壳孤儿）；无 cli.mjs 时退回 tsx.cmd（保留旧路径）
    const tsxCli = path.join(projectRoot, "node_modules/tsx/dist/cli.mjs")
    const hasTsxCli = fs.existsSync(tsxCli)
    const runner = hasTsxCli ? process.execPath : path.join(projectRoot, "node_modules/.bin/tsx.cmd")
    const devArgs = hasTsxCli ? [tsxCli, entry, ...baseArgs] : [entry, ...baseArgs]

    console.log(`[Sidecar] Spawning (${hasTsxCli ? "node+tsx" : "tsx.cmd"}): ${runner} ${devArgs.join(" ")}`)

    this.process = spawn(runner, devArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // process.execPath 是 Electron 二进制，需 ELECTRON_RUN_AS_NODE=1 才表现为 node
      env: spawnEnv(opts.version),
      shell: !hasTsxCli,
      windowsHide: true,
    })

    this.attachProcessListeners()
    return this.waitForReady()
  }

  /** 挂载子进程 stdout/stderr/exit/error 监听（两条 spawn 路径共用） */
  private attachProcessListeners(): void {
    if (!this.process) return

    let buffer = ""

    this.process.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8")
      buffer += text

      // 解析 ready JSON 行
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        try {
          const data = JSON.parse(line)
          if (data.event === "ready") {
            this.resolvedPort = data.port
            this.resolvedToken = data.token || this.options.authToken || ""
            // 已就绪：清理启动超时定时器，避免 resolve 后残留的 reject 触发 unhandledRejection
            if (this.startupTimer) {
              clearTimeout(this.startupTimer)
              this.startupTimer = null
            }
            const ready = this.resolveReady
            this.resolveReady = null
            this.rejectReady = null
            ready?.({ port: this.resolvedPort, token: this.resolvedToken })
          }
        } catch {
          // 非 JSON 输出（如 console.log）忽略
        }
      }
    })

    this.process.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[Sidecar] ${chunk.toString().trim()}`)
    })

    this.process.on("exit", (code) => {
      console.log(`[Sidecar] Process exited with code ${code}`)
      if (this.startupTimer) {
        clearTimeout(this.startupTimer)
        this.startupTimer = null
      }
      this.process = null
      // 若进程在就绪前退出，reject 等待方，避免 request/waitForReady 永久挂起
      const reject = this.rejectReady
      this.resolveReady = null
      this.rejectReady = null
      reject?.(new Error(`Sidecar process exited before ready (code ${code})`))
    })

    this.process.on("error", (err) => {
      console.error(`[Sidecar] Process error: ${err.message}`)
      if (this.startupTimer) {
        clearTimeout(this.startupTimer)
        this.startupTimer = null
      }
      this.process = null
      const reject = this.rejectReady
      this.resolveReady = null
      this.rejectReady = null
      reject?.(err)
    })
  }

  /**
   * 等待本次 start 的 ready JSON。
   * 修改点：移除"resolvedPort > 0 则短路返回"的优化路径。
   * 原因：多 start() 竞态下 resolvedPort 可能残留旧端口（06:04 连环重连死循环根因），
   * 短路会返回陈旧端口导致 health 打错误端口而 ECONNREFUSED；readyPromise 在每次
   * start() 重建，直接 await 它始终拿到本次进程的端口（已 resolve 的 promise 复用结果，无性能损失）。
   */
  async waitForReady(): Promise<{ port: number; token: string }> {
    return this.readyPromise!
  }

  /** 发送 API 请求到 Core 服务 */
  async request(method: string, apiPath: string, body?: unknown, timeoutMs?: number): Promise<any> {
    const { port, token } = await this.waitForReady()

    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : undefined

      const options: http.RequestOptions = {
        hostname: "127.0.0.1",
        port,
        path: apiPath,
        method,
        // agent:false 每次新建连接：避免复用被服务端 keepAliveTimeout 关闭的
        // 空闲 socket（复用时触发 ECONNRESET/socket hang up，造成健康检查假阴性）
        agent: false,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}),
        },
        timeout: timeoutMs,
      }

      const req = http.request(options, (res) => {
        let data = ""
        res.on("data", (chunk: string) => { data += chunk })
        res.on("end", () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve(data)
          }
        })
      })

      req.on("error", (err) => { console.error(`[Sidecar] request ${method} ${apiPath} error: ${err.message} (code=${(err as NodeJS.ErrnoException).code})`); reject(err) })
      req.on("timeout", () => {
        req.destroy()
        reject(new Error("Request timed out"))
      })
      if (postData) req.write(postData)
      req.end()
    })
  }

  /** 建立 SSE 连接并监听事件 */
  async connectSSE(
    apiPath: string,
    body: unknown,
    onEvent: (event: string, data: any) => void,
    onDone?: () => void,
    onError?: (err: Error) => void,
  ): Promise<() => void> {
    const { port, token } = await this.waitForReady()

    const postData = JSON.stringify(body)
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: apiPath,
      method: "POST",
      // agent:false：避免复用被服务端关闭的空闲 keep-alive socket（同 request）
      agent: false,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Length": Buffer.byteLength(postData),
      },
      // SSE 底层 socket 超时：core 每 15s 发心跳，60s 空闲才视为失联
      timeout: 60_000,
    }

      const req = http.request(options, (res) => {
        console.log(`[Sidecar] connectSSE ${apiPath} -> status ${res.statusCode}`)
        let buffer = ""

        res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8")
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""

        let currentEvent = "message"
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith("data: ")) {
            const dataStr = line.slice(6).trim()
            try {
              const data = JSON.parse(dataStr)
              onEvent(currentEvent, data)
            } catch { /* 忽略解析错误 */ }
          } else if (line.startsWith("id: ")) {
            // 忽略 event id
          }
        }
      })

      res.on("end", () => {
        onDone?.()
      })

      res.on("error", (err) => {
        onError?.(err)
      })
    })

    req.on("error", (err) => { console.error(`[Sidecar] connectSSE ${apiPath} error: ${err.message} (code=${(err as NodeJS.ErrnoException).code})`); onError?.(err) })
    req.on("timeout", () => {
      console.error(`[Sidecar] connectSSE ${apiPath} timed out`)
      req.destroy()
      onError?.(new Error("SSE connection timed out"))
    })
    req.on("close", () => console.log(`[Sidecar] connectSSE ${apiPath} closed`))
    req.write(postData)
    req.end()

    return () => { req.destroy() }
  }

  /** 停止 Core 服务进程 */
  async stop(): Promise<void> {
    const proc = this.process
    this.process = null
    if (!proc) return

    // Windows 先杀整个进程树（兜底清理 tsx.cmd → node 孙进程等孤儿），POSIX 发 SIGTERM
    try {
      if (process.platform === "win32" && proc.pid) {
        await new Promise<void>((res) => {
          const tk = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
          tk.on("exit", () => res())
          tk.on("error", () => res())
        })
      } else {
        proc.kill("SIGTERM")
      }
    } catch { /* ignore */ }

    // 等待进程退出，超时 5s 强杀
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try { proc.kill("SIGKILL") } catch { /* ignore */ }
        resolve()
      }, 5000)
      proc.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
