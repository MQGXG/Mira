/**
 * 动态插件 Runner — 运行期自修改的执行与生命周期
 *
 * 流程：define（预检+登记）→ run（沙箱求值+挂载为真实 Cordis 插件）
 * → stop（卸载回滚）→ undefine（删除）。
 * 挂载的插件作为真实 Cordis fiber，卸载时自动回滚其注册的所有 effect。
 */

import type { Context } from "../vendor/cordis/index"
import { DynamicPluginRegistry } from "./registry"
import type { PluginId, PackageId } from "./registry"
import type { SelfModConfig } from "./registry"
import { buildCtxFacade, createSandbox, evaluateHostCode, precheckCode } from "./sandbox"
import { SelfModStorage } from "./storage"
import { pluginRecoveryStore, type PluginRecoveryStore, type RecoveryTransaction } from "./recovery"

/** 插件形状校验：function 或 { apply } 对象 */
function isPlugin(value: unknown): boolean {
  if (typeof value === "function") return true
  return !!value && typeof value === "object" && typeof (value as { apply?: unknown }).apply === "function"
}

export interface RunResult {
  ok: boolean
  message: string
  pluginId?: string
  packageId?: string
  /** 该版本是否携带 client half（浏览器端代码） */
  hasClientCode?: boolean
}

export class DynamicPluginRunner {
  private registry: DynamicPluginRegistry
  /** 已激活插件 → 沙箱求值的插件对象（卸载用） */
  private activePlugins = new Map<PluginId, unknown>()
  /** 持久化（可选）：定义持久化到 SQLite，重启恢复 */
  private storage: SelfModStorage | null = null

  constructor(private ctx: Context, config: SelfModConfig = {}, storage?: SelfModStorage) {
    this.registry = new DynamicPluginRegistry(config)
    this.storage = storage ?? null
  }

  /** 绑定持久化（装配时调用） */
  attachStorage(storage: SelfModStorage): void {
    this.storage = storage
  }

  /** 从持久化恢复某会话的插件定义（不自动 run，模型可 re-run） */
  async restoreFromStorage(sessionId?: string): Promise<number> {
    if (!this.storage) return 0
    const groups = sessionId
      ? await this.storage.loadBySession(sessionId)
      : await this.storage.loadAll()
    for (const g of groups) {
      this.registry.restorePlugin(g.sessionId, g.pluginId as PluginId, g.packages)
    }
    return groups.length
  }

  /** 定义新插件（编译预检 + 登记为不可变版本） */
  define(sessionId: string, name: string, purpose: string, code: string, clientCode?: string): { pluginId: PluginId; packageId: PackageId } {
    const trimmedName = name.trim()
    const trimmedPurpose = purpose.trim()
    if (!trimmedName) throw new Error("插件 name 不能为空")
    if (!trimmedPurpose) throw new Error("插件 purpose 不能为空")
    if (!code || !code.trim()) throw new Error("插件 code 不能为空")
    // 编译预检：拦截语法错误，让模型先修正再定义
    precheckCode(code)
    if (clientCode) precheckCode(clientCode)
    const ids = this.registry.define(sessionId, trimmedName, trimmedPurpose, code, clientCode)
    // 持久化定义（SQLite，重启恢复）
    const plugin = this.registry.get(ids.pluginId)
    if (plugin) void this.storage?.savePlugin(sessionId, plugin)
    return ids
  }

  /** 向已有插件追加新版本 */
  definePackage(sessionId: string, pluginId: PluginId, name: string, purpose: string, code: string, clientCode?: string): { packageId: PackageId } {
    if (!this.registry.owns(pluginId, sessionId)) throw new Error(`插件 ${pluginId} 不存在或不属于当前会话`)
    precheckCode(code)
    if (clientCode) precheckCode(clientCode)
    const packageId = this.registry.addPackage(pluginId, name, purpose, code, clientCode)
    // 持久化新版本
    const plugin = this.registry.get(pluginId)
    if (plugin) void this.storage?.savePlugin(sessionId, plugin)
    return { packageId }
  }

  /**
   * 激活插件：沙箱求值 → 挂载为真实 Cordis 插件
   * @param mode run：启动当前版本；update：切换版本
   */
  async run(
    sessionId: string,
    pluginId: PluginId,
    packageId: PackageId,
    mode: "run" | "update" = "run",
    options: { recoveryStore?: PluginRecoveryStore } = {},
  ): Promise<RunResult> {
    const recovery = options.recoveryStore ?? pluginRecoveryStore
    // begin 之后的一切失败路径都会 recover 回滚 WAL；begin 之前抛错时 txn 为 undefined，无需回滚
    let txn: RecoveryTransaction | undefined
    try {
      // 审批门（防御性检查）：ctx.permissions 明确 deny "selfmod" 时拒绝激活。
      // 常规审批由 turn-runner 三层 Gate 处理（工具 permission: "selfmod"），此处兜底。
      const perms = this.ctx.get("permissions") as { evaluate(action: string, permission?: string): "allow" | "deny" | "ask" } | undefined
      if (perms?.evaluate("selfmod") === "deny") {
        return { ok: false, message: `权限拒绝：动态插件激活（selfmod）被当前权限规则禁止` }
      }
      if (!this.registry.owns(pluginId, sessionId)) {
        return { ok: false, message: `插件 ${pluginId} 不存在或不属于当前会话` }
      }
      const plugin = this.registry.get(pluginId)!
      const pkg = this.registry.getPackage(pluginId, packageId)
      if (!pkg) return { ok: false, message: `插件 ${pluginId} 无版本 ${packageId}` }

      // mode 校验（对齐 dsh run/update 语义）
      if (mode === "update" && plugin.currentPackageId === undefined) {
        return { ok: false, message: `插件 ${pluginId} 尚无激活版本，请用 mode: "run" 启动` }
      }
      if (mode === "run" && plugin.currentPackageId !== undefined && plugin.currentPackageId !== packageId) {
        return { ok: false, message: `插件 ${pluginId} 当前版本为 ${plugin.currentPackageId}，请用 mode: "update" 切换` }
      }

      // prevPackageId = 当前正在运行的健康版本。currentPackageId 只在成功 markRunning 时更新，
      // 是"最后成功运行的版本" = last-known-good；fresh run 时为 undefined → null。
      // update 时必然 ≠ target；不取"排除 target 后 createdAt 最新"——那可能是从未运行验证过的版本。
      const prevPackageId = plugin.currentPackageId !== undefined && plugin.currentPackageId !== packageId
        ? plugin.currentPackageId
        : null
      // 激活前写 WAL（崩溃窗口保护）
      txn = await recovery.begin(sessionId, pluginId, mode, packageId, prevPackageId)

      // 停止旧激活（切换版本时先卸载）
      await this.stop(sessionId, pluginId)

      // 沙箱求值
      const sandbox = createSandbox(pluginId, buildCtxFacade(this.ctx))
      const evaluated = await evaluateHostCode(sandbox, pkg.code, pluginId, this.registry.vmTimeoutMs)
      if (!isPlugin(evaluated)) {
        const hint = evaluated === undefined ? "（是否忘了 return 插件对象？）" : "（期望 function 或 { apply(ctx) }）"
        this.registry.markFailed(pluginId, packageId, "插件代码未返回有效插件形状 " + hint)
        // recover 自身失败不掩盖"未返回有效插件形状"的可操作提示（残留 prepared 由启动时 recoverPending 兜底）
        await recovery.recover(sessionId, txn.transactionId, "install-failed").catch(() => {})
        return { ok: false, message: `插件 ${pluginId} 求值失败：未返回有效插件形状 ${hint}` }
      }

      // 挂载为真实 Cordis 插件（可逆 effect，卸载自动回滚）
      await (this.ctx as unknown as { plugin(p: unknown, config?: unknown): Promise<unknown> }).plugin(evaluated, { sessionId })
      this.activePlugins.set(pluginId, evaluated)
      this.registry.markRunning(pluginId, packageId)
      const hasClientCode = !!pkg.clientCode
      // 正常路径立即了结事务（seal→markHealthy→clear，激活即时生效，无需重启验证）。
      // 注意：此处 WAL 写失败（sql.js 本地写失败概率极低）会抛错进 catch 返回 ok:false 误报——
      // 插件此时已挂载运行，误报靠用户重试/进程重启自愈（prepared 残留由启动时 recoverPending 处理）。
      await recovery.seal(sessionId, txn.transactionId)
      await recovery.markHealthy(sessionId, txn.transactionId)
      await recovery.clear(sessionId, txn.transactionId)
      return {
        ok: true,
        message: `插件 ${pluginId} 已激活（版本 ${packageId}）${hasClientCode ? "，含浏览器端 client half" : ""}。如不再需要可调用 mira_plugin_stop 停止。`,
        pluginId,
        packageId,
        hasClientCode,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.registry.markFailed(pluginId, packageId, msg)
      // 失败路径与 isPlugin 分支对齐：begin 之后的一切异常都回滚 WAL（prepared → rolled-back）。
      // recover 自身失败不掩盖原始错误（残留 prepared 由启动时 recoverPending 兜底）。
      if (txn) await recovery.recover(sessionId, txn.transactionId, "install-failed").catch(() => {})
      return { ok: false, message: `插件 ${pluginId} 激活失败：${msg}` }
    }
  }

  /** 停止插件（卸载 fiber，自动回滚其注册的 hooks/services/tools） */
  async stop(sessionId: string, pluginId: PluginId): Promise<RunResult> {
    try {
      if (!this.registry.owns(pluginId, sessionId)) {
        return { ok: false, message: `插件 ${pluginId} 不存在或不属于当前会话` }
      }
      const active = this.activePlugins.get(pluginId)
      if (active) {
        this.ctx.registry.delete(active as never)
        this.activePlugins.delete(pluginId)
      }
      this.registry.clearRun(pluginId)
      return { ok: true, message: `插件 ${pluginId} 已停止` }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `插件 ${pluginId} 停止失败：${msg}` }
    }
  }

  /** 删除插件（含所有版本） */
  async undefine(sessionId: string, pluginId: PluginId): Promise<RunResult> {
    if (!this.registry.owns(pluginId, sessionId)) {
      return { ok: false, message: `插件 ${pluginId} 不存在或不属于当前会话` }
    }
    await this.stop(sessionId, pluginId)
    this.registry.delete(pluginId)
    // 从持久化删除
    await this.storage?.deletePlugin(sessionId, pluginId)
    return { ok: true, message: `插件 ${pluginId} 及其所有版本已删除` }
  }

  /** 列出会话内的插件（源隔离，不含源码） */
  list(sessionId: string): Array<{
    pluginId: string
    name: string
    packageCount: number
    currentPackageId?: string
    status?: string
    error?: string
  }> {
    return this.registry.ofSession(sessionId).map((p) => {
      const keys = [...p.packages.keys()]
      const latest = p.currentPackageId ?? keys[keys.length - 1]
      const latestPkg = latest ? p.packages.get(latest) : undefined
      return {
        pluginId: p.pluginId,
        name: latestPkg?.name ?? "",
        packageCount: p.packages.size,
        currentPackageId: p.currentPackageId,
        status: p.run?.status,
        error: p.run?.error,
      }
    })
  }

  /** 查看插件详情（含版本列表，不含源码） */
  inspect(sessionId: string, pluginId: PluginId): unknown | null {
    if (!this.registry.owns(pluginId, sessionId)) return null
    const p = this.registry.get(pluginId)!
    return {
      pluginId: p.pluginId,
      packages: [...p.packages.values()].map((pkg) => ({
        packageId: pkg.packageId,
        name: pkg.name,
        purpose: pkg.purpose,
        createdAt: pkg.createdAt,
      })),
      currentPackageId: p.currentPackageId,
      run: p.run,
    }
  }

  /** 获取插件最新定义的版本 id */
  latestPackageId(pluginId: PluginId): PackageId | undefined {
    const p = this.registry.get(pluginId)
    if (!p || p.packages.size === 0) return undefined
    return [...p.packages.values()].sort((a, b) => b.createdAt - a.createdAt)[0].packageId
  }

  /** 获取某版本的 client half 源码（渲染进程执行；无则 undefined） */
  getClientCode(sessionId: string, pluginId: PluginId, packageId: PackageId): string | undefined {
    if (!this.registry.owns(pluginId, sessionId)) return undefined
    return this.registry.getPackage(pluginId, packageId)?.clientCode
  }

  /** 访问底层注册表（测试/扩展用） */
  getRegistry(): DynamicPluginRegistry {
    return this.registry
  }
}
