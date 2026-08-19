/**
 * OfficeCli provider (capability: "office")
 *
 * Service Provider: {@link OfficeCliProvider} — local implementation that probes
 * for the officecli binary across 5 locations, then executes commands through
 * the subprocess seam. Fail-closed: no binary → isAvailable() === false.
 */

import * as fs from "fs"
import * as path from "path"
import { OFFICE_CAPABILITY, type OfficeProvider, type OfficeResult, type OfficeRunOptions } from "./office"
import { getSubprocess } from "./subprocess"
import { capabilityRegistry } from "./index"

const DEFAULT_TIMEOUT_MS = 60_000
const EXE_NAME = process.platform === "win32" ? "officecli.exe" : "officecli"

function isWindows(): boolean {
  return process.platform === "win32"
}

/** 打包资源位置：electron-builder extraResources → resources/officecli/officecli.exe */
function bundledPaths(): string[] {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (!resourcesPath) return []
  return [path.join(resourcesPath, "officecli", EXE_NAME)]
}

/** 已知安装位：Windows `%LOCALAPPDATA%\OfficeCli`，macOS/Linux `~/.officecli` */
function knownInstallPaths(): string[] {
  if (isWindows()) {
    const local = process.env.LOCALAPPDATA
    return local ? [path.join(local, "OfficeCli", EXE_NAME)] : []
  }
  const home = process.env.HOME || ""
  return [path.join(home, ".officecli", EXE_NAME)]
}

/** PATH 中查找可执行文件 */
function findInPath(name: string): string | null {
  const pathVar = process.env.PATH || ""
  const dirs = pathVar.split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    try {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 跳过不可访问目录 */
    }
  }
  return null
}

export interface OfficeCliProviderOptions {
  /** 显式探测候选列表（测试注入 / 外部自定义安装位）；提供时跳过内置 5 级探测 */
  candidates?: string[]
}

export class OfficeCliProvider implements OfficeProvider {
  readonly name = "officecli"
  private resolved: string | null = null

  constructor(
    private extraPaths: string[] = [],
    private opts: OfficeCliProviderOptions = {},
  ) {}

  /**
   * 探测链：
   * 1) 显式注入 candidates（外部自定义/测试）
   * 2) OFFICECLI_PATH → PATH → 已知安装位 → 打包资源 → extraPaths
   */
  findOfficeCli(): string | null {
    if (this.resolved) return this.resolved
    let candidates = this.opts.candidates
    if (!candidates) {
      const builtin: string[] = []
      if (process.env.OFFICECLI_PATH) builtin.push(process.env.OFFICECLI_PATH)
      const inPath = findInPath(EXE_NAME)
      if (inPath) builtin.push(inPath)
      builtin.push(...knownInstallPaths())
      builtin.push(...bundledPaths())
      builtin.push(...this.extraPaths)
      candidates = builtin
    }
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        this.resolved = c
        return c
      }
    }
    return null
  }

  isAvailable(): boolean {
    return this.findOfficeCli() !== null
  }

  findPath(): string | null {
    return this.findOfficeCli()
  }

  async run(args: string[], options?: OfficeRunOptions): Promise<OfficeResult> {
    const bin = this.findOfficeCli()
    if (!bin) {
      return { stdout: "", stderr: "OfficeCLI not found", exitCode: 127, timedOut: false }
    }
    const result = await getSubprocess().run(bin, args, {
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cwd: options?.cwd,
    })
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    }
  }
}

/** 创建 office provider（幂等注册由调用方负责，返回 unload） */
export function createOfficeCliProvider(extraPaths: string[] = [], opts?: OfficeCliProviderOptions): OfficeCliProvider {
  return new OfficeCliProvider(extraPaths, opts)
}

/** 注册 office 能力缝 provider（可逆卸载，对齐 dsh reversible effect） */
export function registerOfficeCapability(extraPaths: string[] = [], opts?: OfficeCliProviderOptions): () => void {
  return capabilityRegistry.register(OFFICE_CAPABILITY, createOfficeCliProvider(extraPaths, opts))
}