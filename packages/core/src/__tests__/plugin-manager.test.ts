import { describe, expect, test } from "vitest"
import { PluginManager, type Plugin, type PluginHook } from "../plugin/index"
import { pluginHooks } from "../shared/plugin-hooks"
import { VoiceRegistry } from "../voice/registry"

function makePlugin(name: string, hooks: PluginHook[] = [], destroy?: () => Promise<void> | void): Plugin {
  return {
    metadata: { name, version: "1.0.0", description: `test ${name}` },
    hooks,
    destroy,
  }
}

describe("PluginManager 可逆卸载", () => {
  test("unloadPlugin 回滚全局 hooks（listenerCount 减少）", async () => {
    const manager = new PluginManager("/tmp/ws")
    const handler = () => {}
    const plugin = makePlugin("p1", [{ name: "pre_llm", handler }])
    ;(manager as unknown as { plugins: Map<string, Plugin> }).plugins.set("p1", plugin)
    ;(manager as unknown as { hooks: Map<string, PluginHook[]> }).hooks.set("pre_llm", [plugin.hooks![0]])
    ;(manager as unknown as { registerHook: (h: PluginHook, n: string) => void }).registerHook(plugin.hooks![0], "p1")

    const before = pluginHooks.listenerCount("pre_llm")
    expect(before).toBeGreaterThan(0)

    await manager.unloadPlugin("p1")
    const after = pluginHooks.listenerCount("pre_llm")
    expect(after).toBeLessThan(before)
    expect(manager.getAllPlugins()).toHaveLength(0)
  })

  test("unloadPlugin 调用插件 destroy", async () => {
    const manager = new PluginManager("/tmp/ws")
    let destroyed = false
    const plugin = makePlugin("p2", [], () => { destroyed = true })
    ;(manager as unknown as { plugins: Map<string, Plugin> }).plugins.set("p2", plugin)
    await manager.unloadPlugin("p2")
    expect(destroyed).toBe(true)
  })

  test("destroyAll 清空所有插件", async () => {
    const manager = new PluginManager("/tmp/ws")
    ;(manager as unknown as { plugins: Map<string, Plugin> }).plugins.set("a", makePlugin("a"))
    ;(manager as unknown as { plugins: Map<string, Plugin> }).plugins.set("b", makePlugin("b"))
    await manager.destroyAll()
    expect(manager.getAllPlugins()).toHaveLength(0)
  })

  test("registerVoice 注册插件语音引擎到 VoiceRegistry（含自定义工厂）", async () => {
    const manager = new PluginManager("/tmp/ws")
    const plugin: Plugin = {
      metadata: { name: "voice-plugin", version: "1.0.0", description: "test voice" },
      async initialize(ctx) {
        ctx.registerVoice({
          def: { id: "plugin-tts", kind: "tts", label: "插件 TTS", implementation: "plugin-tts" },
          factory: {
            kind: "tts",
            factory: () => ({ type: "custom", isAvailable: () => true, speak: async () => {}, stop: () => {} }),
          },
        })
      },
    }
    ;(manager as unknown as { plugins: Map<string, Plugin> }).plugins.set("voice-plugin", plugin)
    await manager.initializePlugins({ workspace: "/tmp/ws", config: { enabled: true } })
    expect(VoiceRegistry.listCatalog().some((e) => e.id === "plugin-tts" && e.kind === "tts")).toBe(true)
  })
})
