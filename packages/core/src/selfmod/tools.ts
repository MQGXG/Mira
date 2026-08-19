/**
 * 运行期自修改工具 — mira_plugin_*（模型可见）
 *
 * Agent 可定义/激活/卸载自己的插件（VM 沙箱 + 可逆 effect）。
 * 工具结果直接回注给模型（工具返回即模型上下文）。
 */

import { z } from "zod"
import { make } from "../shared/tool"
import type { ToolResult } from "../shared/tool"
import type { DynamicPluginRunner } from "./runner"

/** 成功结果 */
const ok = (output: string): ToolResult => ({ success: true, output })
/** 失败结果 */
const fail = (error: string): ToolResult => ({ success: false, error })

/** 模块级单例（由 setupSelfModification 装配） */
let pluginRunner: DynamicPluginRunner | null = null

export function setDynamicPluginRunner(r: DynamicPluginRunner | null): void {
  pluginRunner = r
}

export function getDynamicPluginRunner(): DynamicPluginRunner | null {
  return pluginRunner
}

function needRunner(): DynamicPluginRunner {
  if (!pluginRunner) throw new Error("运行期自修改未启用（未装配 DynamicPluginRunner）")
  return pluginRunner
}

function sessionOf(ctx: { sessionID?: string }): string {
  return ctx.sessionID || "default"
}

/** 定义新插件（编译预检 + 登记版本） */
export const pluginDefineTool = make({
  name: "mira_plugin_define",
  description:
    "Define a new dynamic plugin that runs in the current session. The plugin code is an async function body that MUST return a plugin object: either a function (ctx, config) => ... or an object with an apply(ctx) method. Inside it you can use: ctx.on('agent/pre-step', (messages, next) => next()) to hook the agent loop, ctx.get('tools') to access tools, ctx.provide(name, value) to register a service, ctx.effect(() => () => cleanup) for reversible registration. The code runs in a sandboxed VM (plain JavaScript, no TypeScript, no require/setTimeout/fetch). Re-define with a new version to update.",
  inputSchema: z.object({
    name: z.string().min(1).describe("Plugin name (short, unique intent label)"),
    purpose: z.string().min(1).describe("What this plugin does, for inspection"),
    code: z.string().min(1).describe("Plugin source code: async function body returning a plugin object"),
    client: z.string().optional().describe("Optional browser-side (client half) code: an async function body that renders/handles UI in the renderer. Executed in the renderer sandbox."),
  }),
  outputSchema: z.string(),
  permission: "selfmod",
  async execute(input, ctx) {
    const runner = needRunner()
    const { pluginId, packageId } = runner.define(sessionOf(ctx), input.name, input.purpose, input.code, input.client)
    return ok(`已定义动态插件 ${pluginId}（版本 ${packageId}${input.client ? "，含 client half" : ""}）。用 mira_plugin_run 激活它。`)
  },
})

/** 激活插件 */
export const pluginRunTool = make({
  name: "mira_plugin_run",
  description:
    "Activate a defined dynamic plugin (evaluate its code in the VM sandbox and mount it as a real Cordis plugin). mode 'run' starts the current version; mode 'update' switches to another version. Its hooks/services/tools take effect immediately and are rolled back on mira_plugin_stop.",
  inputSchema: z.object({
    pluginId: z.string().min(1).describe("Plugin id from mira_plugin_define"),
    packageId: z.string().optional().describe("Package version to activate (defaults to the latest defined)"),
    mode: z.enum(["run", "update"]).optional().describe("run=start current version, update=switch version"),
  }),
  outputSchema: z.string(),
  permission: "selfmod",
  async execute(input, ctx) {
    const runner = needRunner()
    const sessionId = sessionOf(ctx)
    // 未指定 packageId 时用最新定义版本
    const packageId = input.packageId ?? runner.latestPackageId(input.pluginId as never)
    if (!packageId) return fail(`插件 ${input.pluginId} 没有可用版本，请先 mira_plugin_define。`)
    const result = await runner.run(sessionId, input.pluginId as never, packageId as never, input.mode ?? "run")
    return result.ok
      ? ok(`✅ ${result.message}`)
      : fail(`❌ ${result.message}（可检查代码后重新 define 或调整）`)
  },
})

/** 停止插件 */
export const pluginStopTool = make({
  name: "mira_plugin_stop",
  description:
    "Stop a running dynamic plugin. All hooks, tools, and services it registered are rolled back (reversible effects). Its packages remain defined and can be re-run.",
  inputSchema: z.object({
    pluginId: z.string().min(1).describe("Plugin id to stop"),
  }),
  outputSchema: z.string(),
  async execute(input, ctx) {
    const runner = needRunner()
    const result = await runner.stop(sessionOf(ctx), input.pluginId as never)
    return result.ok ? ok(`✅ ${result.message}`) : fail(`❌ ${result.message}`)
  },
})

/** 删除插件 */
export const pluginUndefineTool = make({
  name: "mira_plugin_undefine",
  description:
    "Permanently remove a dynamic plugin and all its package versions. The plugin must first be stopped.",
  inputSchema: z.object({
    pluginId: z.string().min(1).describe("Plugin id to remove"),
  }),
  outputSchema: z.string(),
  async execute(input, ctx) {
    const runner = needRunner()
    const result = await runner.undefine(sessionOf(ctx), input.pluginId as never)
    return result.ok ? ok(`✅ ${result.message}`) : fail(`❌ ${result.message}`)
  },
})

/** 列出插件 */
export const pluginListTool = make({
  name: "mira_plugin_list",
  description:
    "List all dynamic plugins defined in the current session, with their status and version count.",
  inputSchema: z.object({}),
  outputSchema: z.string(),
  async execute(_input, ctx) {
    const runner = needRunner()
    const plugins = runner.list(sessionOf(ctx))
    if (plugins.length === 0) return ok("当前会话没有已定义的动态插件。")
    const lines = plugins.map((p) => {
      const status = p.status === "running" ? "🟢 running" : p.status === "failed" ? `🔴 failed: ${p.error ?? ""}` : "⚪ idle"
      return `- ${p.pluginId} (${p.name}) versions=${p.packageCount} current=${p.currentPackageId ?? "none"} ${status}`
    })
    return ok(`当前会话动态插件：\n${lines.join("\n")}`)
  },
})

/** 查看插件详情 */
export const pluginInspectTool = make({
  name: "mira_plugin_inspect",
  description:
    "Inspect a dynamic plugin's package versions and activation state (source code is not returned).",
  inputSchema: z.object({
    pluginId: z.string().min(1).describe("Plugin id to inspect"),
  }),
  outputSchema: z.string(),
  async execute(input, ctx) {
    const runner = needRunner()
    const detail = runner.inspect(sessionOf(ctx), input.pluginId as never) as {
      packages: Array<{ packageId: string; name: string; purpose: string }>
      currentPackageId?: string
      run?: { status: string; error?: string }
    } | null
    if (!detail) return fail(`插件 ${input.pluginId} 不存在或不属于当前会话。`)
    const lines = detail.packages.map((p) => `- ${p.packageId} (${p.name}): ${p.purpose}`)
    return ok([
      `插件 ${detail.currentPackageId ? "当前激活" : "未激活"}（current=${detail.currentPackageId ?? "none"}）`,
      `状态: ${detail.run?.status ?? "idle"}${detail.run?.error ? ` error=${detail.run.error}` : ""}`,
      `版本:`,
      ...lines,
    ].join("\n"))
  },
})
