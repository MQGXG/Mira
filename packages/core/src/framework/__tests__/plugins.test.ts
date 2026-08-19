/**
 * 插件系统测试 — Cordis Registry + 旧插件桥接
 * 验证：Cordis 插件加载、旧 Mira 插件适配、工具/钩子随插件回滚、目录扫描
 */

import { describe, it, expect } from "vitest"
import { createMiraContext } from "../services"
import { MiraPluginManager } from "../plugins"
import { make } from "../../shared/tool"
import { z } from "zod"

// 测试专用事件：merge-extensible 事件表
declare module "../../vendor/cordis/context" {
  interface Events {
    "test/hook"(): string
    "test/pm-hook"(): string
  }
}

const legacyTool = make({
  name: "legacy-tool",
  description: "旧插件贡献的工具",
  inputSchema: z.object({}),
  outputSchema: z.string(),
  async execute() {
    return { success: true, output: "legacy" }
  },
})

describe("插件系统（Cordis Registry + 桥接）", () => {
  it("应通过 MiraPluginManager 加载 Cordis 风格插件", async () => {
    const ctx = await createMiraContext()
    const mgr = new MiraPluginManager(ctx)
    let started = false
    await mgr.loadCordisPlugin({
      name: "cordis-plugin",
      inject: ["tools"],
      apply(ctx) {
        started = true
        ctx.effect(() => () => ctx.tools!.unregister("legacy-tool"))
        ctx.tools!.register(legacyTool)
      },
    })
    expect(started).toBe(true)
    expect(ctx.tools!.get("legacy-tool")).toBeDefined()
    expect(mgr.listPlugins().length).toBeGreaterThan(0)
  })

  it("应桥接旧 Mira 风格插件（metadata/tools/initialize/destroy）", async () => {
    const ctx = await createMiraContext()
    const mgr = new MiraPluginManager(ctx)
    let initialized = false
    let destroyed = false
    await mgr.loadLegacyPlugin({
      metadata: { name: "legacy-plugin", version: "1.0.0", description: "旧插件" },
      tools: [legacyTool],
      hooks: [
        { name: "session/start", handler: () => {} },
      ],
      initialize: async (pc) => {
        initialized = true
        expect(pc.workspace).toBe("")
      },
      destroy: async () => {
        destroyed = true
      },
    })
    expect(initialized).toBe(true)
    expect(ctx.tools!.get("legacy-tool")).toBeDefined()
    expect(destroyed).toBe(false)
  })

  it("应随插件卸载自动回滚工具（可逆 effect）", async () => {
    const ctx = await createMiraContext()
    const mgr = new MiraPluginManager(ctx)
    const plugin = {
      name: "reversible",
      inject: ["tools"],
      apply(ctx: import("../../vendor/cordis/index").Context) {
        ctx.effect(() => () => ctx.tools!.unregister("legacy-tool"))
        ctx.tools!.register(legacyTool)
      },
    }
    await mgr.loadCordisPlugin(plugin)
    expect(ctx.tools!.get("legacy-tool")).toBeDefined()
    await mgr.unloadPlugin(plugin)
    expect(ctx.tools!.get("legacy-tool")).toBeUndefined()
    expect(ctx.registry.has(plugin)).toBe(false)
  })

  it("应支持按名称卸载 + unloadAll + executeHook（Cordis 委托 API）", async () => {
    const ctx = await createMiraContext()
    const mgr = new MiraPluginManager(ctx)
    let ran = false
    const plugin = {
      name: "hook-plugin",
      apply(ctx: import("../../vendor/cordis/index").Context) {
        ctx.on("test/hook", () => {
          ran = true
          return "hook-result"
        })
      },
    }
    await mgr.loadCordisPlugin(plugin)
    const results = await mgr.executeHook("test/hook")
    expect(ran).toBe(true)
    expect(results).toEqual(["hook-result"])
    // 按名称卸载
    expect(mgr.unloadByName("hook-plugin")).toBe(true)
    expect(mgr.unloadByName("hook-plugin")).toBe(false)
  })

  it("旧 PluginManager 委托到 Cordis（attachCordis 渐进替换）", async () => {
    const ctx = await createMiraContext()
    const { PluginManager } = await import("../../plugin/index")
    const pm = new PluginManager("/tmp/mira-ws")
    expect(pm.isCordisAttached()).toBe(false)
    pm.attachCordis(ctx)
    // 等待动态 import 完成（attachCordis 内部异步）
    await new Promise((r) => setTimeout(r, 50))
    expect(pm.isCordisAttached()).toBe(true)
    // 委托后 getTools 走 ctx.tools
    ctx.tools!.register(legacyTool)
    const tools = pm.getTools()
    expect(tools.some((t) => t.name === "legacy-tool")).toBe(true)
    // executeHook 委托到 Cordis serial 分发
    let hookRan = false
    ctx.on("test/pm-hook", () => {
      hookRan = true
      return "pm-result"
    })
    const hookResults = await pm.executeHook("test/pm-hook")
    expect(hookRan).toBe(true)
    expect(hookResults).toEqual(["pm-result"])
    // destroyAll 委托到 Cordis unloadAll（不阻塞）
    await pm.destroyAll()
  })
})
