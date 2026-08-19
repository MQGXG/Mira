/**
 * Bundle / patch 配置组合 — 对齐 dsh Profile → Bundle → patch 分层
 *
 *  - Bundle：命名组合（一组插件引用 + 配置补丁），可像搭积木一样叠加
 *  - patch：{project}/.mira/plugins.patch.json，覆盖任意已注册插件/服务配置行
 *  - dumpConfig：打印实际启动树（对齐 dsh --dump-config）
 *
 * 加载优先级：内置 Bundle → 全局用户 Bundle（~/.config/mira/bundles/）
 * → 项目 Bundle（{project}/.mira/bundles/）→ 项目 patch。
 */

import { readFileSync, existsSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { homedir } from "os"

// ── 类型 ──

/** 插件引用（bundle 中声明要加载的插件 + 配置） */
export interface BundlePluginRef {
  /** 插件名（Cordis plugin name 或注册名） */
  name: string
  /** 插件配置（加载时传给 ctx.plugin） */
  config?: Record<string, unknown>
  /** 是否启用（patch 可覆盖） */
  enabled?: boolean
}

/** Bundle 定义（声明式配置组合） */
export interface BundleDef {
  id: string
  label: string
  description?: string
  /** 要叠加的插件 */
  plugins: BundlePluginRef[]
  /** 对已注册插件/服务的配置补丁（深层合并） */
  patch?: Record<string, unknown>
  /** 适用的 Agent 模式（留空 = 全局适用） */
  profiles?: string[]
}

/** 用户 patch 文件（{project}/.mira/plugins.patch.json） */
export interface BundlePatchFile {
  /** 按插件名覆盖（启用/配置） */
  plugins?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>
  /** 深层配置补丁 */
  patch?: Record<string, unknown>
}

/** resolve 结果：合并后的插件列表 + 补丁 */
export interface BundleResolveResult {
  plugins: BundlePluginRef[]
  patch: Record<string, unknown>
  /** 参与组合的 bundle id 列表（诊断） */
  applied: string[]
}

/** 深层合并（对象递归合并，非对象后者覆盖） */
export function deepMerge<T>(base: T, override: unknown): T {
  if (base === null || base === undefined) return (override ?? base) as T
  if (Array.isArray(base)) return (override ?? base) as T
  if (typeof base === "object" && typeof override === "object" && override !== null && !Array.isArray(override)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = deepMerge(out[k], v)
    }
    return out as T
  }
  return (override === undefined ? base : override) as T
}

// ── 注册表 ──

export class BundleRegistry {
  private bundles = new Map<string, BundleDef>()

  /** 注册内置/程序化 Bundle */
  registerBundle(def: BundleDef): void {
    this.bundles.set(def.id, def)
  }

  /** 从文件加载一个 Bundle */
  loadFromFile(filePath: string): BundleDef | null {
    try {
      const raw = readFileSync(filePath, "utf-8")
      const json = JSON.parse(raw)
      if (!json.id || !Array.isArray(json.plugins)) return null
      this.bundles.set(json.id, json as BundleDef)
      return json as BundleDef
    } catch { return null }
  }

  /** 从目录加载所有 Bundle（*.json） */
  loadFromDir(dirPath: string): void {
    if (!existsSync(dirPath)) return
    try {
      for (const f of readdirSync(dirPath)) {
        if (f.endsWith(".json")) this.loadFromFile(join(dirPath, f))
      }
    } catch { /* 目录读取失败不阻塞 */ }
  }

  /** 加载全局 + 项目 Bundle 目录 */
  loadFromPaths(projectDir?: string): void {
    this.loadFromDir(resolve(homedir(), ".config", "mira", "bundles"))
    if (projectDir) this.loadFromDir(resolve(projectDir, ".mira", "bundles"))
  }

  get(id: string): BundleDef | undefined {
    return this.bundles.get(id)
  }

  getAll(): BundleDef[] {
    return Array.from(this.bundles.values())
  }

  /**
   * 解析一组 bundle id 为合并的插件列表 + 配置补丁。
   * 多个 bundle 叠加：插件按出现顺序去重合并（后者配置覆盖），patch 深层合并。
   */
  resolve(ids: string[]): BundleResolveResult {
    const pluginMap = new Map<string, BundlePluginRef>()
    let patch: Record<string, unknown> = {}
    const applied: string[] = []
    for (const id of ids) {
      const def = this.bundles.get(id)
      if (!def) continue
      applied.push(id)
      for (const ref of def.plugins ?? []) {
        const prev = pluginMap.get(ref.name)
        pluginMap.set(ref.name, prev ? { ...prev, ...ref, config: { ...prev.config, ...ref.config } } : { ...ref })
      }
      if (def.patch) patch = deepMerge(patch, def.patch)
    }
    return { plugins: [...pluginMap.values()], patch, applied }
  }

  /** 读取项目 patch 文件（{project}/.mira/plugins.patch.json） */
  loadPatch(projectDir?: string): BundlePatchFile | null {
    if (!projectDir) return null
    const p = resolve(projectDir, ".mira", "plugins.patch.json")
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as BundlePatchFile
    } catch { return null }
  }

  /** 应用 patch 到 resolve 结果（插件启用/配置覆盖 + 深层补丁） */
  applyPatch(result: BundleResolveResult, patch: BundlePatchFile | null): BundleResolveResult {
    if (!patch) return result
    const { plugins, patch: deep } = patch
    if (plugins) {
      for (const [name, cfg] of Object.entries(plugins)) {
        const ref = result.plugins.find((p) => p.name === name)
        if (ref) {
          if (cfg.enabled !== undefined) ref.enabled = cfg.enabled
          if (cfg.config) ref.config = { ...ref.config, ...cfg.config }
        } else if (cfg.enabled !== false) {
          result.plugins.push({ name, enabled: cfg.enabled, config: cfg.config })
        }
      }
    }
    if (deep) result.patch = deepMerge(result.patch, deep)
    return result
  }

  /** 打印实际启动树（对齐 dsh --dump-config） */
  dumpConfig(ids: string[], projectDir?: string): string {
    let result = this.resolve(ids)
    const patch = this.loadPatch(projectDir)
    if (patch) result = this.applyPatch(result, patch)
    const lines: string[] = []
    lines.push(`┌─ Mira 配置组合树`)
    lines.push(`│ bundles: ${ids.join(", ") || "(none)"}`)
    for (const id of ids) {
      const def = this.bundles.get(id)
      lines.push(`│   ${def ? `✔ ${id} (${def.label})` : `✖ ${id} (未找到)`}`)
    }
    lines.push(`│ plugins: ${result.plugins.length}`)
    for (const p of result.plugins) {
      const state = p.enabled === false ? "disabled" : "enabled"
      lines.push(`│   ${state}  ${p.name}${p.config ? `  config=${JSON.stringify(p.config)}` : ""}`)
    }
    if (Object.keys(result.patch).length > 0) {
      lines.push(`│ patch:`)
      for (const [k, v] of Object.entries(result.patch)) {
        lines.push(`│   ${k}: ${JSON.stringify(v)}`)
      }
    }
    if (patch) lines.push(`│ patch-file: ${resolve(projectDir ?? "", ".mira", "plugins.patch.json")} (applied)`)
    lines.push(`└─`)
    return lines.join("\n")
  }
}

/** 模块级单例 */
export const bundleRegistry = new BundleRegistry()
