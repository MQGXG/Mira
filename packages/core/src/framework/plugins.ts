/**
 * MiraPluginManager — Cordis Registry 之上的插件管理器
 *
 * 对齐 dsh ctx.plugin：插件通过 ctx.plugin() 加载，依赖自动解析，
 * 卸载自动回滚。此封装提供：
 *  - loadCordisPlugin：加载 Cordis 风格插件
 *  - loadLegacyPlugin：加载旧 Mira 风格插件（经 adaptMiraPlugin 桥接）
 *  - loadFromDir：扫描 {workspace}/.mira/plugins/ 目录批量加载
 */

import * as fs from "fs/promises"
import * as path from "path"
import { Context } from "../vendor/cordis/index"
import type { Plugin as CordisPlugin } from "../vendor/cordis/index"
import type { Plugin as MiraPlugin } from "../plugin/index"
import { adaptMiraPlugin } from "./plugin-adapter"
import { logError } from "../system/logger"
import type { ToolDef } from "../shared/tool"

export class MiraPluginManager {
  /** 已加载插件映射（label → plugin callback），供卸载/生命周期管理 */
  private loaded = new Map<string, CordisPlugin>()

  constructor(private ctx: Context) {}

  /** 加载 Cordis 风格插件 */
  async loadCordisPlugin(plugin: CordisPlugin, config?: unknown): Promise<void> {
    await this.ctx.plugin(plugin, config)
    this.loaded.set(plugin.name || String(plugin), plugin)
  }

  /** 加载旧 Mira 风格插件（自动桥接），返回桥接后的 Cordis 插件 */
  async loadLegacyPlugin(plugin: MiraPlugin): Promise<CordisPlugin> {
    const cordisPlugin = adaptMiraPlugin(plugin)
    await this.loadCordisPlugin(cordisPlugin)
    this.loaded.set(plugin.metadata?.name || cordisPlugin.name || String(cordisPlugin), cordisPlugin)
    return cordisPlugin
  }

  /** 卸载插件（自动回滚其所有 effect） */
  async unloadPlugin(plugin: CordisPlugin): Promise<void> {
    this.ctx.registry.delete(plugin)
    for (const [label, p] of this.loaded) {
      if (p === plugin) this.loaded.delete(label)
    }
  }

  /** 按名称卸载插件 */
  unloadByName(name: string): boolean {
    const plugin = this.loaded.get(name)
    if (!plugin) return false
    this.ctx.registry.delete(plugin)
    this.loaded.delete(name)
    return true
  }

  /** 卸载全部插件（自动回滚所有 effect） */
  unloadAll(): void {
    for (const plugin of this.loaded.values()) {
      this.ctx.registry.delete(plugin)
    }
    this.loaded.clear()
  }

  /** 列出已注册插件回调 */
  listPlugins(): CordisPlugin[] {
    return Array.from(this.ctx.registry.values()).map((r) => r.callback as CordisPlugin)
  }

  /** 执行插件钩子（Cordis serial 分发，返回首个非空结果） */
  async executeHook(hookName: string, ...args: unknown[]): Promise<unknown[]> {
    const result = await (this.ctx as unknown as { serial(name: string, ...a: unknown[]): Promise<unknown> }).serial(hookName, ...args)
    return result === undefined ? [] : [result]
  }

  /** 获取插件贡献的工具（经 ctx.tools 统一寻址） */
  getTools(): ToolDef[] {
    return this.ctx.tools?.getAll() ?? []
  }

  /** 插件工具是否为空（供桥判断） */
  hasTools(): boolean {
    return (this.ctx.tools?.getAll().length ?? 0) > 0
  }

  /**
   * 扫描 {workspace}/.mira/plugins/ 目录并批量加载。
   * 支持目录插件（<dir>/index.js）与单文件插件（.js）。
   * 同时支持 Cordis 风格（default 导出 { apply }）与旧 Mira 风格（metadata）。
   */
  async loadFromDir(workspace: string): Promise<string[]> {
    const loaded: string[] = []
    const pluginDir = path.join(workspace, ".mira", "plugins")
    try {
      await fs.mkdir(pluginDir, { recursive: true })
      const entries = await fs.readdir(pluginDir, { withFileTypes: true })
      for (const entry of entries) {
        try {
          if (entry.isDirectory()) {
            const indexPath = path.join(pluginDir, entry.name, "index.js")
            try {
              await fs.access(indexPath)
            } catch {
              continue
            }
            const mod = await import(indexPath)
            const candidate = mod.default || mod
            await this.loadCandidate(candidate, entry.name, loaded)
          } else if (entry.isFile() && entry.name.endsWith(".js")) {
            const mod = await import(path.join(pluginDir, entry.name))
            const candidate = mod.default || mod
            await this.loadCandidate(candidate, entry.name.replace(/\.js$/, ""), loaded)
          }
        } catch (error) {
          logError(`[MiraPluginManager] 加载插件 ${entry.name} 失败`, error)
        }
      }
    } catch (error) {
      logError("[MiraPluginManager] 扫描插件目录失败", error)
    }
    return loaded
  }

  /** 识别插件风格并加载（Cordis 风格：有 apply；旧风格：有 metadata） */
  private async loadCandidate(candidate: unknown, label: string, loaded: string[]): Promise<void> {
    const c = candidate as { apply?: unknown; metadata?: unknown }
    if (typeof c?.apply === "function") {
      const cp = c as CordisPlugin
      await this.loadCordisPlugin(cp)
      // 按目录名记录，便于 unloadByName(label) 精确卸载
      this.loaded.set(label, cp)
      loaded.push(label)
      this.ctx.emit("plugin/loaded", label)
    } else if (c?.metadata && (c as MiraPlugin).metadata.name) {
      const mp = c as MiraPlugin
      const cp = await this.loadLegacyPlugin(mp)
      // 按目录名记录，便于 unloadByName(label) 精确卸载
      this.loaded.set(label, cp)
      loaded.push(label)
      this.ctx.emit("plugin/loaded", label)
    }
  }
}
