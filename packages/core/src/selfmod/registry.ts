/**
 * 动态插件注册表 — 运行期自修改的版本管理
 *
 * Plugin（稳定身份，归属 session）→ 多个不可变 Package（版本）。
 * run(启动)/update(切换版本)/stop(停止)/undefine(删除)。
 * 对齐 dsh cordis-host-runner 的 DynamicCordisRegistry。
 */

/** 插件 ID（mint 生成） */
export type PluginId = string & { __brand: "PluginId" }
/** 包 ID（mint 生成，不可变版本） */
export type PackageId = string & { __brand: "PackageId" }

/** 一个不可变包版本 */
export interface DynamicPackage {
  packageId: PackageId
  name: string
  purpose: string
  /** 插件源码（async 函数体，return 插件对象） */
  code: string
  /** 浏览器端 client half 源码（可选：UI 交互插件；渲染进程沙箱执行） */
  clientCode?: string
  createdAt: number
}

/** 动态插件（稳定身份 + 版本集 + 激活状态） */
export interface DynamicPlugin {
  pluginId: PluginId
  sessionId: string
  packages: Map<PackageId, DynamicPackage>
  /** 当前激活的包版本 */
  currentPackageId?: PackageId
  /** 激活的运行信息 */
  run?: {
    packageId: PackageId
    /** 激活时间 */
    startedAt: number
    /** 激活是否成功 */
    status: "running" | "failed"
    error?: string
  }
  createdAt: number
}

/** 运行期自修改配置 */
export interface SelfModConfig {
  /** 每次插件定义分配的 id 前缀（3-6 小写字母） */
  idPrefix?: string
  /** VM 同步求值上限（毫秒），默认 5000 */
  vmTimeoutMs?: number
}

const DEFAULT_ID_PREFIX = "dyn"
const DEFAULT_VM_TIMEOUT = 5000

let counter = 0

function mintId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}`
}

export class DynamicPluginRegistry {
  private plugins = new Map<PluginId, DynamicPlugin>()

  constructor(private config: SelfModConfig = {}) {}

  get vmTimeoutMs(): number {
    return this.config.vmTimeoutMs ?? DEFAULT_VM_TIMEOUT
  }

  get idPrefix(): string {
    return this.config.idPrefix ?? DEFAULT_ID_PREFIX
  }

  /** 创建新插件，返回 (pluginId, packageId) */
  define(sessionId: string, name: string, purpose: string, code: string, clientCode?: string): { pluginId: PluginId; packageId: PackageId } {
    const pluginId = mintId(this.idPrefix) as PluginId
    const plugin: DynamicPlugin = {
      pluginId,
      sessionId,
      packages: new Map(),
      createdAt: Date.now(),
    }
    this.plugins.set(pluginId, plugin)
    const packageId = this.addPackage(pluginId, name, purpose, code, clientCode)
    return { pluginId, packageId }
  }

  /** 向已有插件追加不可变版本 */
  addPackage(pluginId: PluginId, name: string, purpose: string, code: string, clientCode?: string): PackageId {
    const plugin = this.get(pluginId)
    if (!plugin) throw new Error(`动态插件不存在: ${pluginId}`)
    const packageId = mintId("pkg") as PackageId
    plugin.packages.set(packageId, { packageId, name, purpose, code, ...(clientCode ? { clientCode } : {}), createdAt: Date.now() })
    return packageId
  }

  get(pluginId: PluginId): DynamicPlugin | undefined {
    return this.plugins.get(pluginId)
  }

  getPackage(pluginId: PluginId, packageId: PackageId): DynamicPackage | undefined {
    return this.plugins.get(pluginId)?.packages.get(packageId)
  }

  /** 按 session 列出插件（源隔离：只返回归属该 session 的插件） */
  ofSession(sessionId: string): DynamicPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.sessionId === sessionId)
  }

  /** 删除插件（含激活状态） */
  delete(pluginId: PluginId): boolean {
    return this.plugins.delete(pluginId)
  }

  /** 从持久化恢复插件定义（保留原始 id 与创建时间，不重新 mint） */
  restorePlugin(sessionId: string, pluginId: PluginId, packages: Array<{ packageId: PackageId; name: string; purpose: string; code: string; clientCode?: string; createdAt: number }>): void {
    const plugin: DynamicPlugin = {
      pluginId,
      sessionId,
      packages: new Map(),
      createdAt: packages[0]?.createdAt ?? Date.now(),
    }
    for (const p of packages) {
      plugin.packages.set(p.packageId, {
        packageId: p.packageId,
        name: p.name,
        purpose: p.purpose,
        code: p.code,
        ...(p.clientCode ? { clientCode: p.clientCode } : {}),
        createdAt: p.createdAt,
      })
    }
    this.plugins.set(pluginId, plugin)
  }

  /** 校验插件归属（防跨 session 操作） */
  owns(pluginId: PluginId, sessionId: string): boolean {
    const plugin = this.plugins.get(pluginId)
    return !!plugin && plugin.sessionId === sessionId
  }

  /** 更新激活状态 */
  markRunning(pluginId: PluginId, packageId: PackageId): void {    const plugin = this.plugins.get(pluginId)
    if (!plugin) return
    plugin.currentPackageId = packageId
    plugin.run = { packageId, startedAt: Date.now(), status: "running" }
  }

  /** 标记激活失败 */
  markFailed(pluginId: PluginId, packageId: PackageId, error: string): void {
    const plugin = this.plugins.get(pluginId)
    if (!plugin) return
    plugin.run = { packageId, startedAt: Date.now(), status: "failed", error }
  }

  /** 清除激活状态（stop 后） */
  clearRun(pluginId: PluginId): void {
    const plugin = this.plugins.get(pluginId)
    if (plugin) delete plugin.run
  }
}
