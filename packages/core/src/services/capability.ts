/**
 * Capability Seams 服务 — ctx.fs / ctx.subprocess / ctx.shell
 *
 * 对齐 dsh Capability Seams（Service Definition / Provider / Consumer 三角色）：
 *  - Definition：FileSystemProvider / SubprocessProvider / ShellProvider 接口（capability/）
 *  - Provider：默认 Local*，可经 setProvider() 替换（换 Provider 换产品）
 *  - Consumer：工具/插件经 ctx.fs.* 调用，不 import 具体实现
 *
 * 当前阶段：服务注册入统一寻址空间（可注入/可替换），工具逐步迁移到经 seam 调用。
 */

import { Service } from "../vendor/cordis/index"
import type { Context } from "../vendor/cordis/index"
import { defaultFsProvider, FS_CAPABILITY } from "../capability/fs"
import type { FileSystemProvider, FsStats, FsEntry } from "../capability/fs"
import { getSubprocess, LocalSubprocessProvider, SUBPROCESS_CAPABILITY } from "../capability/subprocess"
import type { SubprocessProvider, SubprocessResult, SubprocessOptions } from "../capability/subprocess"
import { getShell, LocalShellProvider, SHELL_CAPABILITY } from "../capability/shell"
import type { ShellProvider } from "../capability/shell"
import { capabilityRegistry } from "../capability"

/** 文件系统服务（Definition 持 Provider，可替换；同步 capabilityRegistry 影响所有经 getFs() 的工具） */
export class MiraFileSystemService extends Service {
  /** 服务名声明（Service 构造默认名） */
  static provide = "fs"
  /** 当前 Provider（默认本地；setProvider 换后端） */
  provider: FileSystemProvider

  constructor(ctx: Context, config: { provider?: FileSystemProvider } = {}) {
    super(ctx, "fs")
    this.provider = config.provider ?? defaultFsProvider
    // 同步 capabilityRegistry（effect 化：fiber 卸载自动回滚）让 read_file/write_file 等经 getFs() 的工具跟随
    ctx.effect(() => capabilityRegistry.register(FS_CAPABILITY, this.provider), "ctx.capability.register(fs)")
  }

  /** 替换 Provider（换 Provider 换产品：如指向远程沙箱文件系统） */
  setProvider(provider: FileSystemProvider): void {
    this.provider = provider
    capabilityRegistry.register(FS_CAPABILITY, provider)
  }

  async readFile(path: string): Promise<Buffer> {
    return this.provider.readFile(path)
  }
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.provider.writeFile(path, data)
  }
  async stat(path: string): Promise<FsStats | null> {
    return this.provider.stat(path)
  }
  async readdir(path: string): Promise<FsEntry[]> {
    return this.provider.readdir(path)
  }
  async mkdir(path: string, recursive?: boolean): Promise<void> {
    return this.provider.mkdir(path, recursive)
  }
  async exists(path: string): Promise<boolean> {
    return this.provider.exists(path)
  }
}

/** 子进程服务（Definition 持 Provider，可替换；同步 capabilityRegistry 影响经 getSubprocess() 的工具） */
export class MiraSubprocessService extends Service {
  /** 服务名声明（Service 构造默认名） */
  static provide = "subprocess"
  provider: SubprocessProvider

  constructor(ctx: Context, config: { provider?: SubprocessProvider } = {}) {
    super(ctx, "subprocess")
    this.provider = config.provider ?? getSubprocess()
    // effect 化：fiber 卸载自动回滚 capabilityRegistry 注册
    ctx.effect(() => capabilityRegistry.register(SUBPROCESS_CAPABILITY, this.provider), "ctx.capability.register(subprocess)")
  }

  setProvider(provider: SubprocessProvider): void {
    this.provider = provider
    capabilityRegistry.register(SUBPROCESS_CAPABILITY, provider)
  }

  run(command: string, args: string[], options: SubprocessOptions): Promise<SubprocessResult> {
    return this.provider.run(command, args, options)
  }
}

/** Shell 服务（Definition 持 Provider，可替换；同步 capabilityRegistry 影响经 getShell() 的工具） */
export class MiraShellService extends Service {
  /** 服务名声明（Service 构造默认名） */
  static provide = "shell"
  provider: ShellProvider

  constructor(ctx: Context, config: { provider?: ShellProvider } = {}) {
    super(ctx, "shell")
    this.provider = config.provider ?? getShell()
    // effect 化：fiber 卸载自动回滚 capabilityRegistry 注册
    ctx.effect(() => capabilityRegistry.register(SHELL_CAPABILITY, this.provider), "ctx.capability.register(shell)")
  }

  setProvider(provider: ShellProvider): void {
    this.provider = provider
    capabilityRegistry.register(SHELL_CAPABILITY, provider)
  }

  resolve(preferred?: string): string {
    return this.provider.resolve(preferred)
  }
  buildArgs(shell: string, command: string): string[] {
    return this.provider.buildArgs(shell, command)
  }
}

// 导出默认 Provider 类（供注册/替换）
export { LocalFileSystemProvider } from "../capability/fs"
export type { FileSystemProvider, FsStats, FsEntry } from "../capability/fs"
export { LocalSubprocessProvider } from "../capability/subprocess"
export type { SubprocessProvider, SubprocessResult, SubprocessOptions } from "../capability/subprocess"
export { LocalShellProvider } from "../capability/shell"
export type { ShellProvider } from "../capability/shell"
