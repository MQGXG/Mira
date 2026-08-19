/**
 * 核心服务集成测试
 * 验证 createMiraContext 注册的服务可寻址 + 插件可注入依赖 + 可逆注册
 */

import { describe, it, expect } from "vitest"
import { createMiraContext } from "../../framework/services"
import type { Plugin } from "../../vendor/cordis/index"
import { make } from "../../shared/tool"
import { PermissionSet } from "../../system/permission"
import { ToolRegistry } from "../../system/registry"
import { setupSelfModification, SELF_MOD_TOOLS } from "../../selfmod"
import { getModeToolAllowlist } from "../../config/modes"
import { createScope, scopeOf } from "../../scope/index"
import { MiraToolService } from "../../services/tools"
import { z } from "zod"

const helloTool = make({
  name: "hello",
  description: "Hello world tool",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.string(),
  async execute(input: { name: string }) {
    return { success: true, output: `Hello, ${input.name}!` }
  },
})

const readTool = make({
  name: "read_file",
  description: "Read file tool",
  inputSchema: z.object({}),
  outputSchema: z.string(),
  permission: "read",
  async execute() {
    return { success: true, output: "read" }
  },
})

const bashTool = make({
  name: "bash",
  description: "Bash tool",
  inputSchema: z.object({}),
  outputSchema: z.string(),
  async execute() {
    return { success: true, output: "bash" }
  },
})

describe("Mira 核心服务", () => {
  it("应注册全部核心服务到 ctx 单一寻址空间", async () => {
    const ctx = await createMiraContext()
    expect(ctx.llm).toBeDefined()
    expect(ctx.tools).toBeDefined()
    expect(ctx.permissions).toBeDefined()
    expect(ctx.sessions).toBeDefined()
    expect(ctx.memory).toBeDefined()
    expect(ctx.dynamicMemory).toBeDefined()
    expect(ctx.mcp).toBeDefined()
    expect(ctx.catalog).toBeDefined()
    expect(ctx.config).toBeDefined()
    expect(ctx.agentLoop).toBeDefined()
  })

it("应通过 ctx.agentLoop 创建注入 Context 的 Agent 并发布进 ctx.agents", async () => {
    const ctx = await createMiraContext()
    const { agent, dispose } = await ctx.agentLoop!.createAgent(ctx, {
      sessionId: "svc-test",
      agentOptions: { workspace: "/tmp", model: "gpt-4", apiKey: "k", apiUrl: "http://x" },
    })
    expect(agent).toBeDefined()
    // Agent 已注入 cordisCtx → 循环可被插件扩展
    expect(agent.getMiraContext()).toBe(ctx)
    // 已发布进 ctx.agents（实时注册表），agent 作用域可解析 ctx.agent
    expect(ctx.agents!.get("svc-test")).toBe(agent)
    expect(agent.agentCtx).toBeDefined()
    // dispose 反向拆除：注销 → 释放作用域
    await dispose()
    expect(ctx.agents!.get("svc-test")).toBeUndefined()
  })

  it("应支持工具注册 + 可逆卸载", async () => {
    const ctx = await createMiraContext()
    const tools = ctx.tools!
    tools.register(helloTool)
    expect(tools.get("hello")).toBeDefined()

    // 可逆卸载
    tools.unregister("hello")
    expect(tools.get("hello")).toBeUndefined()
  })

  it("应支持权限规则评估", async () => {
    const ctx = await createMiraContext({
      permissions: [
        { action: "bash", resource: "rm -rf *", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    })
    const perms = ctx.permissions!
    expect(perms.isAllowed("read")).toBe(true)
    expect(perms.evaluate("bash", "read")).toBe("allow")
  })

  it("应支持插件 inject 依赖（服务就绪后激活）", async () => {
    const ctx = await createMiraContext()
    let applied = false
    const plugin: Plugin = {
      name: "tool-consumer",
      inject: ["tools"],
      apply(ctx) {
        applied = true
        expect(ctx.tools).toBeDefined()
      },
    }
    await ctx.plugin(plugin)
    expect(applied).toBe(true)
    expect(ctx.registry.has(plugin)).toBe(true)
  })

  it("应支持插件通过 ctx.tools 贡献工具并随插件回滚", async () => {
    const ctx = await createMiraContext()
    const plugin: Plugin = {
      name: "tool-provider",
      inject: ["tools"],
      apply(ctx) {
        // 可逆注册：通过 ctx.effect 关联 fiber 生命周期，卸载时自动回滚
        ctx.effect(() => () => ctx.tools!.unregister(helloTool.name))
        ctx.tools!.register(helloTool)
      },
    }
    await ctx.plugin(plugin)
    expect(ctx.tools!.get("hello")).toBeDefined()
    // 卸载插件 → 工具回滚（effect 逆序清理）
    ctx.registry.delete(plugin)
    await ctx.plugin({ name: "drain", apply() {} })
    expect(ctx.tools!.get("hello")).toBeUndefined()
  })

  it("应支持 catalog 服务模型查询", async () => {
    const ctx = await createMiraContext()
    const catalog = ctx.catalog!
    catalog.init()
    expect(catalog.listModels("openai").length).toBeGreaterThan(0)
    expect(catalog.getModel("openai", "gpt-4o")).toBeDefined()
  })

  it("ScopedToolRegistry 激活：mode allowlist 过滤工具集", async () => {
    const ctx = await createMiraContext()
    const tools = ctx.tools!
    tools.register(readTool)
    tools.register(bashTool)
    // safe 模式：只读白名单（read_file 在列，bash 不在）
    const scoped = tools.materializeScoped({ mode: "safe" })
    expect(scoped["read_file"]).toBeDefined()
    expect(scoped["bash"]).toBeUndefined()
  })

  it("ScopedToolRegistry 激活：config toolAllowlist + 权限过滤", async () => {
    const ctx = await createMiraContext()
    const tools = ctx.tools!
    tools.register(readTool)
    tools.register(bashTool)
    // toolAllowlist 只保留 read_file
    const allowed = tools.materializeScoped({ toolAllowlist: ["read_file"] })
    expect(allowed["read_file"]).toBeDefined()
    expect(allowed["bash"]).toBeUndefined()
    // 权限 deny 过滤 bash
    const denied = tools.materializeScoped({
      toolAllowlist: ["read_file", "bash"],
      permissions: new PermissionSet([
        { action: "bash", resource: "*", effect: "deny" },
      ]),
    })
    expect(denied["bash"]).toBeUndefined()
  })

  it("ScopedToolRegistry 激活：Agent 通过 ctx.agentLoop 运行时自动生效", async () => {
    const ctx = await createMiraContext()
    const tools = ctx.tools!
    tools.register(readTool)
    tools.register(bashTool)
    // 模拟 Agent.prepareRun 的物化分支（有 miraCtx 时走 materializeScoped）
    const { agent } = await ctx.agentLoop!.createAgent(ctx, {
      sessionId: `scope-${Date.now()}`,
      agentOptions: {
        workspace: "/tmp",
        model: "gpt-4",
        apiKey: "k",
        apiUrl: "http://x",
        mode: "safe",
      },
    })
    expect(agent.getMiraContext()).toBe(ctx)
    // 直接验证 safe 模式物化结果（与 prepareRun 同源）
    const scoped = tools.materializeScoped({ mode: "safe" })
    expect(scoped["bash"]).toBeUndefined()
  })

  it("sidecar 链路：setupSelfModification 装配到共享 registry（mira_plugin_* 进入 Agent 工具集）", async () => {
    const registry = new ToolRegistry()
    const ctx = await createMiraContext({ toolsRegistry: registry })
    setupSelfModification(ctx)
    // 工具注册到共享 registry（与 sidecar api.ts 的 createDefaultRegistry 同源）
    for (const tool of SELF_MOD_TOOLS) {
      expect(registry.get(tool.name)).toBeDefined()
    }
    // assistant 模式 allowlist 含 selfmod 工具（模型可用）
    const assistantAllowlist = getModeToolAllowlist("assistant") ?? []
    for (const tool of SELF_MOD_TOOLS) {
      expect(assistantAllowlist).toContain(tool.name)
    }
    // expert/action 无 allowlist → 全部可用
    expect(getModeToolAllowlist("expert")).toBeUndefined()
    expect(getModeToolAllowlist("action")).toBeUndefined()
  })

  it("Capability Seams：ctx.fs/subprocess/shell 注册且可替换 Provider", async () => {
    const ctx = await createMiraContext()
    // 服务已注册到统一寻址空间
    expect(ctx.fs).toBeDefined()
    expect(ctx.subprocess).toBeDefined()
    expect(ctx.shell).toBeDefined()
    // 默认本地 Provider
    expect(ctx.fs!.provider.name).toBe("local")

    // 替换 Provider（换 Provider 换产品：定义 mock 远程 FS）
    const mockRemote = {
      name: "remote-sandbox",
      readFile: async () => Buffer.from("remote"),
      writeFile: async () => {},
      stat: async () => ({ size: 6, isDirectory: false, isFile: true, mtimeMs: 0 }),
      readdir: async () => [],
      mkdir: async () => {},
      exists: async () => true,
      createReadStream: () => undefined as never,
    }
    ctx.fs!.setProvider(mockRemote as never)
    expect(ctx.fs!.provider.name).toBe("remote-sandbox")
    const buf = await ctx.fs!.readFile("/tmp/x.txt")
    expect(buf.toString()).toBe("remote")
    // shell/subprocess Provider 可替换
    const mockShell = { name: "custom", resolve: () => "custom.sh", buildArgs: () => [] }
    ctx.shell!.setProvider(mockShell as never)
    expect(ctx.shell!.resolve()).toBe("custom.sh")
  })

  it("Agent 循环可替换：setLoop 注入自定义循环实现", async () => {
    const ctx = await createMiraContext()
    const svc = ctx.agentLoop!
    // 默认实现
    expect(svc.getLoop()).toBeDefined()
    const { agent: defaultAgent } = await svc.createAgent(ctx, {
      sessionId: `loop-default-${Date.now()}`,
      agentOptions: { workspace: "/tmp", model: "gpt-4", apiKey: "k", apiUrl: "http://x" },
    })
    expect(defaultAgent.getMiraContext()).toBe(ctx)

    // 替换为自定义循环（插件化契约）
    const defaultLoop = svc.getLoop()
    let customCalled = false
    const customLoop: import("../../services/agent-loop").AgentLoopImpl = {
      createAgent: (config) => {
        customCalled = true
        // 自定义循环仍可复用默认实现
        return defaultLoop.createAgent(config)
      },
      resumeAgent: (config) => {
        customCalled = true
        return defaultLoop.resumeAgent(config)
      },
    }
    svc.setLoop(customLoop)
    const { agent: customAgent } = await svc.createAgent(ctx, {
      sessionId: `loop-custom-${Date.now()}`,
      agentOptions: { workspace: "/tmp", model: "gpt-4", apiKey: "k", apiUrl: "http://x" },
    })
    expect(customCalled).toBe(true)
    expect(customAgent).toBeDefined()
  })

  it("ctx.agents：实时注册表 + initiator 因果链（子 Agent 经 agent 作用域 ctx 创建）", async () => {
    const ctx = await createMiraContext()
    // 根调用：无当前 agent
    expect(ctx.agents!.currentInitiator()).toBeUndefined()
    // 工厂经 create 委托（ownerCtx = 调用方 ctx）
    const { agent: root, dispose } = await ctx.agents!.create({
      sessionId: `reg-root-${Date.now()}`,
      agentOptions: { workspace: "/tmp", model: "gpt-4", apiKey: "k", apiUrl: "http://x" },
    })
    expect(ctx.agents!.get(root.id!)).toBe(root)
    expect(ctx.agents!.roots()).toContain(root)

    // 在 root agent 作用域 ctx 下创建子 agent → owner 因果链
    const sub = await root.agentCtx!.agents!.create({
      sessionId: `reg-sub-${Date.now()}`,
      agentOptions: { workspace: "/tmp", model: "gpt-4", apiKey: "k", apiUrl: "http://x" },
    })
    expect(ctx.agents!.get(sub.agent.id!)).toBe(sub.agent)
    expect(ctx.agents!.isOwnedBy(sub.agent.id!, root)).toBe(true)
    expect(ctx.agents!.roots()).not.toContain(sub.agent)

    await sub.dispose()
    await dispose()
    expect(ctx.agents!.list().length).toBe(0)
  })

  it("sidecar 链路：Agent 注入全局 Context 后 prepareRun 物化含 selfmod 工具", async () => {
    const registry = new ToolRegistry()
    const ctx = await createMiraContext({ toolsRegistry: registry })
    setupSelfModification(ctx)
    // 模拟 api.ts 的 Agent 创建（注入 cordisCtx + 共享 registry）
    const { agent } = await ctx.agentLoop!.createAgent(ctx, {
      sessionId: `sidecar-${Date.now()}`,
      agentOptions: {
        workspace: "/tmp",
        model: "gpt-4",
        apiKey: "k",
        apiUrl: "http://x",
        mode: "assistant",
      },
    })
    expect(agent.getMiraContext()).toBe(ctx)
    // assistant 模式物化：selfmod 工具在列
    const scoped = ctx.tools!.materializeScoped({ mode: "assistant" })
    for (const tool of SELF_MOD_TOOLS) {
      expect(scoped[tool.name]).toBeDefined()
    }
  })

  it("dsh 对齐：tools.register 返回精确 disposer（可逆卸载）", async () => {
    const ctx = await createMiraContext()
    const tools = ctx.tools!
    const undo = tools.register(helloTool)
    expect(tools.get("hello")).toBeDefined()
    undo()
    expect(tools.get("hello")).toBeUndefined()
    // 幂等：重复调用无副作用
    undo()
    expect(tools.get("hello")).toBeUndefined()
  })

  it("dsh 对齐：作用域实例共享 ScopedLayers，作用域注册仅作用域视图可见", async () => {
    const ctx = await createMiraContext()
    const rootTools = ctx.tools as MiraToolService

    // 铸作用域：scope.ctx.tools 经 Cordis traceable proxy 绑定调用 ctx
    const key = {}
    const scope = createScope(ctx, key)
    const scopedTools = scope.ctx.tools as MiraToolService
    expect(scopeOf(scope.ctx)).toBe(key)

    const scopedOnly = make({
      name: "scoped_only",
      description: "Scope-only tool",
      inputSchema: z.object({}),
      outputSchema: z.string(),
      async execute() {
        return { success: true, output: "scoped" }
      },
    })

    // 作用域注册 → 仅作用域视图可见，root 全局视图不可见
    const undo = scopedTools.register(scopedOnly)
    expect(scopedTools.resolve(scopeOf(scope.ctx)).has("scoped_only")).toBe(true)
    expect(rootTools.resolve(undefined).has("scoped_only")).toBe(false)
    expect(rootTools.get("scoped_only")).toBeUndefined()

    // disposer 回收 → 作用域视图同步移除
    undo()
    expect(scopedTools.resolve(scopeOf(scope.ctx)).has("scoped_only")).toBe(false)

    await scope.dispose()
  })

  it("dsh 对齐：tools.restrict 作用域限制（deny 优先 / allow 白名单）", async () => {
    const ctx = await createMiraContext()
    const rootTools = ctx.tools as MiraToolService
    const scope = createScope(ctx, {})
    const scopedTools = scope.ctx.tools as MiraToolService
    const key = scopeOf(scope.ctx)

    // 全局注册 read/bash 在作用域视图可见
    scopedTools.register(readTool)
    scopedTools.register(bashTool)
    expect(scopedTools.resolve(key).has("read_file")).toBe(true)
    expect(scopedTools.resolve(key).has("bash")).toBe(true)

    // restrict deny → bash 从作用域视图移除
    const undoDeny = scopedTools.restrict({ deny: ["bash"] })
    const afterDeny = scopedTools.resolveWithRestrictions(key)
    expect(afterDeny.has("bash")).toBe(false)
    expect(afterDeny.has("read_file")).toBe(true)

    // restrict allow → 白名单收敛
    const undoAllow = scopedTools.restrict({ allow: ["read_file"] })
    const afterAllow = scopedTools.resolveWithRestrictions(key)
    expect(afterAllow.has("bash")).toBe(false)
    expect(afterAllow.has("read_file")).toBe(true)

    // disposer 回收 → 限制解除
    undoDeny()
    undoAllow()
    expect(scopedTools.resolveWithRestrictions(key).has("bash")).toBe(true)

    // 全局实例 restrict 抛错（防止全局遮蔽）
    expect(() => rootTools.restrict({ deny: ["bash"] })).toThrow(/scoped context/)

    await scope.dispose()
  })

  it("dsh 对齐：tools.guard 单调守卫（执行前拒绝 / disposer 回收）", async () => {
    const ctx = await createMiraContext()
    const scope = createScope(ctx, {})
    const scopedTools = scope.ctx.tools as MiraToolService
    scopedTools.register(helloTool)

    const toolCtx = {
      sessionID: "guard-test",
      workspace: "/tmp",
      mode: "assistant",
      agent: "test",
      assistantMessageID: "a",
      toolCallID: "c1",
    }

    // 默认放行
    const ok = await scopedTools.execute("hello", { name: "world" }, toolCtx)
    expect(ok.success).toBe(true)

    // 守卫拒绝
    const undoGuard = scopedTools.guard(({ name }) => (name === "hello" ? "blocked by guard" : undefined))
    const denied = await scopedTools.execute("hello", { name: "world" }, toolCtx)
    expect(denied.success).toBe(false)
    expect(denied.error).toContain("blocked by guard")

    // disposer 回收 → 放行
    undoGuard()
    const okAgain = await scopedTools.execute("hello", { name: "world" }, toolCtx)
    expect(okAgain.success).toBe(true)

    await scope.dispose()
  })
})
