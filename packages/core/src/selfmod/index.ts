/**
 * 运行期自修改模块 — "一切皆插件"的终局形态
 *
 * Agent 在会话中通过 mira_plugin_* 工具定义/激活/卸载自己的插件：
 *  - VM 沙箱执行（node:vm + 预检 + 超时 + Node API 重定向）
 *  - 插件作为真实 Cordis fiber 挂载（可逆 effect，卸载自动回滚）
 *  - 不可变包版本 + run/update 模式 + 会话源隔离
 */

export { createSandbox, buildCtxFacade, precheckCode, evaluateHostCode } from "./sandbox"
export { DynamicPluginRegistry } from "./registry"
export type { DynamicPlugin, DynamicPackage, PluginId, PackageId, SelfModConfig } from "./registry"
export { DynamicPluginRunner } from "./runner"
export type { RunResult } from "./runner"
export { SelfModStorage, selfModStorage } from "./storage"
export type { StoredPluginRow } from "./storage"
export { PluginRecoveryStore, pluginRecoveryStore, RECOVERY_TABLE, RECOVERY_PHASES, recoverPending } from "./recovery"
export type { RecoveryPhase, RecoveryAction, RecoveryFailureReason, RecoveryTransaction, RecoverPendingOptions } from "./recovery"
export {
  pluginDefineTool,
  pluginRunTool,
  pluginStopTool,
  pluginUndefineTool,
  pluginListTool,
  pluginInspectTool,
  setDynamicPluginRunner,
  getDynamicPluginRunner,
} from "./tools"

import type { Context } from "../vendor/cordis/index"
import { DynamicPluginRunner } from "./runner"
import type { SelfModConfig } from "./registry"
import { selfModStorage, SelfModStorage } from "./storage"
import {
  pluginDefineTool,
  pluginRunTool,
  pluginStopTool,
  pluginUndefineTool,
  pluginListTool,
  pluginInspectTool,
  setDynamicPluginRunner,
} from "./tools"

export const SELF_MOD_TOOLS = [
  pluginDefineTool,
  pluginRunTool,
  pluginStopTool,
  pluginUndefineTool,
  pluginListTool,
  pluginInspectTool,
]

/**
 * 装配运行期自修改：
 *  - 创建 DynamicPluginRunner 并注册为模块单例（工具访问）
 *  - 注册 mira_plugin_* 工具到 ctx.tools
 *  - 绑定 SQLite 持久化（插件定义重启恢复）
 * @param ctx Mira root Context（createMiraContext 返回）
 * @param config 可选配置（idPrefix / vmTimeoutMs）
 * @param storage 可选持久化实例（默认模块单例；传 null 禁用）
 */
export function setupSelfModification(ctx: Context, config?: SelfModConfig, storage: SelfModStorage | null = selfModStorage): DynamicPluginRunner {
  const runner = new DynamicPluginRunner(ctx, config, storage ?? undefined)
  setDynamicPluginRunner(runner)
  for (const tool of SELF_MOD_TOOLS) {
    ctx.tools?.register(tool)
  }
  return runner
}
