/**
 * LSP 依赖管理 — 检查并自动安装语言服务器运行依赖
 * 参考 Serena 的 DependencyProvider（版本锁定 + 自动安装），仅支持白名单包
 */

import { spawn, spawnSync } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { getPlatformPaths } from "../config/paths"
import type { LanguageServerDef } from "./server-defs"

/** 默认安装超时（毫秒） */
const INSTALL_TIMEOUT_MS = 120_000

export interface DependencyResolution {
  /** 语言服务器启动命令 */
  command: string
  /** 启动参数 */
  args: string[]
  /** 解析来源：系统已安装 / 本地安装 / 未找到 */
  source: "system" | "local" | "none"
}

/** 查找可执行文件在 PATH 中的路径（Windows 兼容 .cmd/.exe） */
function which(binary: string): string | null {
  const isWin = process.platform === "win32"
  const suffixes = isWin ? ["", ".cmd", ".exe", ".bat"] : [""]
  const pathDirs = (process.env.PATH || "").split(path.delimiter)

  for (const dir of pathDirs) {
    if (!dir) continue
    for (const suffix of suffixes) {
      const candidate = path.join(dir, binary + suffix)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return isWin ? binary + suffix : candidate
        }
      } catch {
        // 目录不存在或权限不足，继续查找
      }
    }
  }
  return null
}

/** 检查 npm 是否可用 */
function hasNpm(): boolean {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  const result = spawnSync(npmCmd, ["--version"], { timeout: 15_000, shell: process.platform === "win32" })
  return result.status === 0
}

/**
 * 语言服务器依赖解析器
 * 解析优先级：系统已安装 → 本地缓存安装 → 自动安装（可选）
 */
export class LSPDependencyResolver {
  private readonly cacheRoot: string
  private readonly autoInstall: boolean

  constructor(options: { cacheRoot?: string; autoInstall?: boolean } = {}) {
    this.cacheRoot = options.cacheRoot ?? path.join(getPlatformPaths().userData, "lsp")
    this.autoInstall = options.autoInstall ?? true
  }

  /** 获取语言服务器的本地安装目录 */
  private installDir(def: LanguageServerDef): string {
    return path.join(this.cacheRoot, def.id)
  }

  /** 获取语言服务器依赖入口脚本的绝对路径 */
  private entryPath(def: LanguageServerDef): string {
    return path.join(this.installDir(def), "node_modules", def.entryScript)
  }

  /** 校验依赖是否已完整安装 */
  private isInstalled(def: LanguageServerDef): boolean {
    try {
      return fs.existsSync(this.entryPath(def))
    } catch {
      return false
    }
  }

  /** 解析语言服务器启动命令 */
  async resolve(def: LanguageServerDef): Promise<DependencyResolution> {
    // 1. 优先使用系统已安装的 typescript-language-server（PATH 中查找）
    const systemBinary = def.dependencies.find((d) => d.name === "typescript-language-server")
    if (systemBinary) {
      const systemPath = which(systemBinary.name)
      if (systemPath) {
        return { command: systemPath, args: ["--stdio"], source: "system" }
      }
    }

    // 2. 使用本地缓存安装
    if (this.isInstalled(def)) {
      return { command: process.execPath, args: [this.entryPath(def), "--stdio"], source: "local" }
    }

    // 3. 可选：自动安装到缓存目录（仅白名单包 + 固定版本）
    if (this.autoInstall) {
      const installed = await this.tryInstall(def)
      if (installed) {
        return { command: process.execPath, args: [this.entryPath(def), "--stdio"], source: "local" }
      }
    }

    return { command: "", args: [], source: "none" }
  }

  /**
   * 自动安装依赖到本地缓存目录
   * 安全约束：包名与版本均来自 LanguageServerDef 白名单，禁止拼接用户输入
   */
  private async tryInstall(def: LanguageServerDef): Promise<boolean> {
    if (!hasNpm()) return false

    const dir = this.installDir(def)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      return false
    }

    const packages = def.dependencies.map((d) => `${d.name}@${d.version}`)
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"

    return new Promise((resolve) => {
      const child = spawn(npmCmd, ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", dir, ...packages], {
        stdio: "ignore",
        shell: process.platform === "win32",
      })
      const timer = setTimeout(() => {
        child.kill()
        resolve(false)
      }, INSTALL_TIMEOUT_MS)

      child.on("close", (code) => {
        clearTimeout(timer)
        if (code === 0 && this.isInstalled(def)) {
          resolve(true)
        } else {
          // 安装失败清理缓存目录，避免残留不完整安装
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch {
            // 清理失败不影响主流程
          }
          resolve(false)
        }
      })
      child.on("error", () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
  }
}

export const lspDependencyResolver = new LSPDependencyResolver()
