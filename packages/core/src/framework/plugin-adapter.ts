/**
 * 插件适配器 — 旧 Mira Plugin 接口 → Cordis Plugin 接口
 *
 * 让存量插件（metadata/tools/hooks/initialize/destroy 风格）无需重写即可
 * 运行在 Cordis 框架上：工具/钩子注册走可逆 effect，随插件卸载自动回滚。
 */

import type { Context, Plugin as CordisPlugin } from "../vendor/cordis/index"
import type {
  Plugin as MiraPlugin,
  PluginContext as MiraPluginContext,
  PluginHook as MiraPluginHook,
} from "../plugin/index"
import type { ToolDef } from "../shared/tool"
import { mapLegacyHookName, adaptLegacyHook } from "../shared/plugin-hooks"

/** 构建旧 PluginContext（桥接 Cordis 服务到旧插件 API） */
function buildPluginContext(ctx: Context, config: unknown): MiraPluginContext {
  const workspace = ctx.get("config") && typeof (ctx.get("config") as { getWorkspace?: () => string }).getWorkspace === "function"
    ? (ctx.get("config") as { getWorkspace(): string }).getWorkspace()
    : ""
  return {
    workspace,
    config: { enabled: true, options: (config ?? {}) as Record<string, unknown> },
    registerTool: (tool: ToolDef) => {
      ctx.tools?.register(tool)
    },
    registerHook: (hook: MiraPluginHook) => {
      // 旧插件钩子名是任意字符串事件 → 遗留名映射到 dsh 命名事件 + handler 签名适配
      ctx.on(mapLegacyHookName(hook.name) as never, adaptLegacyHook(hook.name, hook.handler) as never)
    },
    registerProvider: (def) => {
      ctx.catalog?.register(def)
    },
    registerVoice: (_engine) => {
      // 语音引擎目录：voice 服务接入后可在此桥接
    },
    getPlugin: (name: string) => {
      // 旧插件元数据映射：Cordis runtime 无 metadata，返回 undefined 兜底
      return undefined
    },
    log: (message: string) => {
      ctx.logger.info(message)
    },
  }
}

/**
 * 将旧 Mira Plugin 适配为 Cordis Plugin。
 * 返回的插件可作为普通 Cordis 插件加载，卸载时自动回滚工具/钩子/销毁。
 */
export function adaptMiraPlugin(miraPlugin: MiraPlugin): CordisPlugin {
  const name = miraPlugin.metadata?.name || "mira-plugin"
  const tools = miraPlugin.tools || []
  const hooks = miraPlugin.hooks || []
  const inject: string[] = []
  if (tools.length > 0) inject.push("tools")

  return {
    name,
    inject,
    apply(ctx: Context, config: unknown) {
      // 可逆注册工具：卸载时自动回滚
      for (const tool of tools) {
        ctx.effect(() => {
          ctx.tools?.register(tool)
          return () => ctx.tools?.unregister(tool.name)
        }, `mira-plugin:${name}/tool:${tool.name}`)
      }

      // 可逆注册钩子：卸载时自动移除监听（遗留名 → dsh 命名事件 + 适配）
      for (const hook of hooks) {
        ctx.effect(() => {
          const dispose = ctx.on(mapLegacyHookName(hook.name) as never, adaptLegacyHook(hook.name, hook.handler) as never)
          return () => dispose()
        }, `mira-plugin:${name}/hook:${hook.name}`)
      }

      // 调用旧 initialize（传桥接 PluginContext）
      miraPlugin.initialize?.(buildPluginContext(ctx, config))

      // 卸载时调用旧 destroy
      if (miraPlugin.destroy) {
        ctx.effect(() => () => {
          miraPlugin.destroy?.()
        }, `mira-plugin:${name}/destroy`)
      }
    },
  }
}
