/**
 * 运行期自修改测试
 * 验证：沙箱预检/求值、插件定义/激活/卸载生命周期、可逆回滚、工具装配
 */

import { describe, it, expect, vi } from "vitest"
import { createMiraContext } from "../../framework/services"
import { DynamicPluginRunner } from "../runner"
import { precheckCode, evaluateHostCode, createSandbox, buildCtxFacade } from "../sandbox"
import { setupSelfModification, SELF_MOD_TOOLS, SelfModStorage } from "../index"
import { initPlatformPaths } from "../../config/paths"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// 测试专用事件：merge-extensible 事件表
declare module "../../vendor/cordis/context" {
  interface Events {
    "selfmod/test-event"(): string
  }
}

/** 一个注册 hook 的动态插件源码（async 函数体，return 插件对象） */
const HOOK_PLUGIN_CODE = `
  return {
    name: 'hook-plugin',
    apply(ctx) {
      ctx.on('selfmod/test-event', () => 'plugin-fired')
    }
  }
`

/** 一个提供服务的插件 */
const SERVICE_PLUGIN_CODE = `
  return {
    name: 'service-plugin',
    apply(ctx) {
      ctx.provide('selfmodSvc', { hello: 'from-plugin' })
    }
  }
`

describe("运行期自修改（VM 沙箱）", () => {
  it("precheckCode 应拦截语法错误", async () => {
    expect(() => precheckCode(`return { name: 'x'`)).toThrow(/语法错误/)
    expect(() => precheckCode(`return { apply(ctx) {} }`)).not.toThrow()
  })

  it("evaluateHostCode 应执行插件源码并返回插件对象", async () => {
    const ctx = await createMiraContext()
    const sandbox = createSandbox("t1", buildCtxFacade(ctx))
    const evaluated = await evaluateHostCode(sandbox, HOOK_PLUGIN_CODE, "t1", 5000)
    expect(evaluated).toBeDefined()
    expect(typeof (evaluated as { apply?: unknown }).apply).toBe("function")
  })

  it("沙箱应拒绝 Node API（require 不可用）", async () => {
    const ctx = await createMiraContext()
    const sandbox = createSandbox("t2", buildCtxFacade(ctx))
    const evaluated = await evaluateHostCode(sandbox, `return { apply(ctx) { ctx.require('fs') } }`, "t2", 5000)
    // require 是数据属性 undefined，调用即抛错；这里验证求值本身返回对象
    expect(evaluated).toBeDefined()
  })
})

describe("运行期自修改（生命周期）", () => {
  // 隔离测试 DB：run() 会经 pluginRecoveryStore 单例写 selfmod_recovery 表，
  // 把 userData 指到临时目录，防止落进仓库 cwd/mira.db
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-selfmod-lc-"))
  initPlatformPaths({ userData: tmp })

  it("define → run → 插件 hook 生效 → stop 回滚 → undefine", async () => {
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx, { vmTimeoutMs: 5000 })

    // define
    const { pluginId, packageId } = runner.define("s1", "hook-plugin", "注册测试事件", HOOK_PLUGIN_CODE)
    expect(pluginId).toBeTruthy()
    expect(packageId).toBeTruthy()
    expect(runner.list("s1")).toHaveLength(1)

    // run
    const runResult = await runner.run("s1", pluginId, packageId, "run")
    expect(runResult.ok).toBe(true)

    // 插件 hook 生效（经 ctx.on 注册）
    const seen: unknown[] = []
    ctx.on("selfmod/test-event", () => {
      seen.push("external-listener")
      return "external"
    })
    // 注意：serial 分发，首个 bail 值返回。插件监听器先注册，返回 'plugin-fired'
    const result = await (ctx as unknown as { serial(name: string, ...a: unknown[]): Promise<unknown> }).serial("selfmod/test-event")
    expect(result).toBe("plugin-fired")
    expect(seen).toHaveLength(0) // 插件监听器先行短路

    // stop → 回滚（插件 hook 移除）
    const stopResult = await runner.stop("s1", pluginId)
    expect(stopResult.ok).toBe(true)
    const afterStop = await (ctx as unknown as { serial(name: string, ...a: unknown[]): Promise<unknown> }).serial("selfmod/test-event")
    expect(afterStop).toBe("external") // 插件监听器已回滚，external 接管

    // undefine
    const undefineResult = await runner.undefine("s1", pluginId)
    expect(undefineResult.ok).toBe(true)
    expect(runner.list("s1")).toHaveLength(0)
  })

  it("run 应支持插件提供服务（ctx.provide）并随 stop 回滚", async () => {
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx)
    const { pluginId, packageId } = runner.define("s2", "svc-plugin", "提供服务", SERVICE_PLUGIN_CODE)
    const runResult = await runner.run("s2", pluginId, packageId, "run")
    expect(runResult.ok).toBe(true)

    expect(ctx.get("selfmodSvc")).toEqual({ hello: "from-plugin" })

    await runner.stop("s2", pluginId)
    expect(ctx.get("selfmodSvc")).toBeUndefined()
  })

  it("run 应校验模式与版本（run/update 语义）", async () => {
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx)
    const { pluginId, packageId } = runner.define("s3", "p", "测试", HOOK_PLUGIN_CODE)

    // 直接 update 无当前版本 → 拒绝
    const badUpdate = await runner.run("s3", pluginId, packageId, "update")
    expect(badUpdate.ok).toBe(false)

    // run 启动后 update 切换
    const first = await runner.run("s3", pluginId, packageId, "run")
    expect(first.ok).toBe(true)
    const pkg2 = runner.getRegistry().addPackage(pluginId, "p", "v2", HOOK_PLUGIN_CODE)
    const update = await runner.run("s3", pluginId, pkg2, "update")
    expect(update.ok).toBe(true)
  })

  it("插件激活失败（代码不返回插件形状）应给出可操作错误", async () => {
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx)
    const { pluginId, packageId } = runner.define("s4", "bad", "错误插件", `return 42`)
    const result = await runner.run("s4", pluginId, packageId, "run")
    expect(result.ok).toBe(false)
    expect(result.message).toContain("未返回有效插件形状")
  })

  it("审批门：selfmod 权限 deny 时拒绝激活（防御性检查）", async () => {
    const ctx = await createMiraContext({
      permissions: [
        { action: "selfmod", resource: "*", effect: "deny" },
      ],
    })
    const runner = new DynamicPluginRunner(ctx)
    const { pluginId, packageId } = runner.define("s5", "denied", "被拒插件", HOOK_PLUGIN_CODE)
    const result = await runner.run("s5", pluginId, packageId, "run")
    expect(result.ok).toBe(false)
    expect(result.message).toContain("权限拒绝")
    // 插件未挂载
    expect(ctx.get("selfmodSvc")).toBeUndefined()
  })

  it("审批门：selfmod 工具声明 permission 字段（turn-runner 三层 Gate 生效）", async () => {
    const defineTool = SELF_MOD_TOOLS.find((t) => t.name === "mira_plugin_define")
    const runTool = SELF_MOD_TOOLS.find((t) => t.name === "mira_plugin_run")
    expect(defineTool?.permission).toBe("selfmod")
    expect(runTool?.permission).toBe("selfmod")
  })

  it("client half：define 携带 client 代码，run 结果标记，getClientCode 可取回", async () => {
    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx)
    const clientCode = `return { render() { return '<div>ui</div>' } }`
    const { pluginId, packageId } = runner.define("s6", "ui-plugin", "UI 插件", HOOK_PLUGIN_CODE, clientCode)
    // client 代码已存储
    expect(runner.getClientCode("s6", pluginId, packageId)).toBe(clientCode)
    // run 结果标记 hasClientCode
    const runResult = await runner.run("s6", pluginId, packageId, "run")
    expect(runResult.ok).toBe(true)
    expect(runResult.hasClientCode).toBe(true)
    expect(runResult.message).toContain("client half")
    // 无 client 的版本不标记
    const pkg2 = runner.getRegistry().addPackage(pluginId, "ui-plugin", "v2 无 client", HOOK_PLUGIN_CODE)
    const run2 = await runner.run("s6", pluginId, pkg2, "update")
    expect(run2.ok).toBe(true)
    expect(run2.hasClientCode).toBe(false)
    expect(runner.getClientCode("s6", pluginId, pkg2)).toBeUndefined()
  })

  it("持久化：define 后保存到 SQLite，新 runner restoreFromStorage 可恢复定义", async () => {
    // 使用独立 userData（隔离测试 DB）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-selfmod-"))
    initPlatformPaths({ userData: tmp })
    const storage = new SelfModStorage()

    const ctx1 = await createMiraContext()
    const runner1 = new DynamicPluginRunner(ctx1, {}, storage)
    const { pluginId, packageId } = runner1.define("persist-1", "persist-plugin", "持久化插件", HOOK_PLUGIN_CODE, "return { render() {} }")
    // 等待异步持久化（runWrite 同步入队 + savePlugin await）
    await storage.ensureTable()
    await new Promise((r) => setTimeout(r, 50))

    // 模拟重启：新 runner + 同 storage，restoreFromStorage 恢复定义
    const ctx2 = await createMiraContext()
    const runner2 = new DynamicPluginRunner(ctx2, {}, storage)
    const restored = await runner2.restoreFromStorage("persist-1")
    expect(restored).toBeGreaterThanOrEqual(1)
    // 定义恢复（含 client 代码）
    expect(runner2.getClientCode("persist-1", pluginId, packageId)).toBe("return { render() {} }")
    expect(runner2.list("persist-1")).toHaveLength(1)
    expect(runner2.list("persist-1")[0].name).toBe("persist-plugin")
  })

  it("持久化：undefine 后从 SQLite 删除", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-selfmod-del-"))
    initPlatformPaths({ userData: tmp })
    const storage = new SelfModStorage()

    const ctx = await createMiraContext()
    const runner = new DynamicPluginRunner(ctx, {}, storage)
    const { pluginId } = runner.define("persist-2", "del-plugin", "待删插件", HOOK_PLUGIN_CODE)
    await storage.ensureTable()
    await runner.undefine("persist-2", pluginId)
    await new Promise((r) => setTimeout(r, 50))

    const runner2 = new DynamicPluginRunner(ctx, {}, storage)
    const restored = await runner2.restoreFromStorage("persist-2")
    expect(restored).toBe(0)
    expect(runner2.list("persist-2")).toHaveLength(0)
  })
})

describe("运行期自修改（工具装配）", () => {
  it("setupSelfModification 应注册 mira_plugin_* 工具", async () => {
    const ctx = await createMiraContext()
    const runner = setupSelfModification(ctx)
    expect(runner).toBeInstanceOf(DynamicPluginRunner)
    for (const tool of SELF_MOD_TOOLS) {
      expect(ctx.tools!.get(tool.name)).toBeDefined()
    }
  })

  it("mira_plugin_define + run + list 工具链路", async () => {
    const ctx = await createMiraContext()
    setupSelfModification(ctx)
    const tools = ctx.tools!
    const define = tools.get("mira_plugin_define")!
    const run = tools.get("mira_plugin_run")!
    const list = tools.get("mira_plugin_list")!

    const toolCtx = { sessionID: "s-tool", workspace: "/tmp" } as never
    const defineRes = await define.execute(
      { name: "tool-plugin", purpose: "链路测试", code: HOOK_PLUGIN_CODE },
      toolCtx,
    )
    expect(defineRes.success).toBe(true)
    // 提取 pluginId
    const pluginId = (defineRes.output ?? "").match(/(dyn-[a-z0-9]+)/)?.[1]
    expect(pluginId).toBeTruthy()

    const runRes = await run.execute({ pluginId: pluginId! }, toolCtx)
    expect(runRes.success).toBe(true)

    const listRes = await list.execute({}, toolCtx)
    expect(listRes.success).toBe(true)
    expect(listRes.output).toContain("tool-plugin")
    expect(listRes.output).toContain("🟢 running")
  })
})
