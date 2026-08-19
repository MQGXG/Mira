/**
 * SystemPrompt 作用域化测试（批 8）
 * 验证：ScopedLayers 作用域 shadow 全局、disposer 回滚、system-prompt/change + assemble 事件。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMiraContext } from "../../framework/services"
import { createScope } from "../../scope/index"
import { initPlatformPaths } from "../../config/paths"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

describe("SystemPrompt 作用域化（批 8）", () => {
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-sp-"))
    initPlatformPaths({ userData: tmp })
  })

  it("全局 section/variable 正常装配", async () => {
    const ctx = await createMiraContext()
    const sp = ctx.systemPrompt!
    sp.section({ name: "role", order: 10, text: () => "你是一名助手" })
    sp.variable("name", () => "Mira")

    const out = await sp.assemble({ base: "{{name}}" })
    expect(out.system).toContain("Mira")
    expect(out.system).toContain("你是一名助手")
  })

  it("作用域 ctx 下注册 shadow 全局同名 section，且 disposer 回滚", async () => {
    const ctx = await createMiraContext()
    const sp = ctx.systemPrompt!
    sp.section({ name: "role", order: 10, text: () => "全局角色" })

    // 铸一个作用域 ctx（模拟 agent scope）
    const scope = createScope(ctx, { sessionId: "scoped-agent" })
    const scopedSP = scope.ctx.systemPrompt as typeof sp

    // 作用域覆盖全局同名 section
    const dispose = scopedSP.section({ name: "role", order: 10, text: () => "作用域角色" })

    const outScoped = await sp.assemble({ base: "", scope: scope.ctx as never })
    expect(outScoped.system).toContain("作用域角色")
    expect(outScoped.system).not.toContain("全局角色")

    // disposer 回滚 → 恢复全局
    dispose()
    const outGlobal = await sp.assemble({ base: "", scope: scope.ctx as never })
    expect(outGlobal.system).toContain("全局角色")
    expect(outGlobal.system).not.toContain("作用域角色")

    await scope.dispose()
  })

  it("作用域 variable 覆盖全局同名变量", async () => {
    const ctx = await createMiraContext()
    const sp = ctx.systemPrompt!
    sp.variable("name", () => "全局名")

    const scope = createScope(ctx, { sessionId: "scoped-var" })
    const scopedSP = scope.ctx.systemPrompt as typeof sp
    scopedSP.variable("name", () => "作用域名")

    const out = await sp.assemble({ base: "你好 {{name}}", scope: scope.ctx as never })
    expect(out.system).toContain("你好 作用域名")

    await scope.dispose()
  })

  it("system-prompt/change 在作用域注册/撤销时触发", async () => {
    const ctx = await createMiraContext()
    const sp = ctx.systemPrompt!
    const changes: string[] = []
    ctx.on("system-prompt/change", () => changes.push("change"))

    const scope = createScope(ctx, { sessionId: "scoped-chg" })
    const scopedSP = scope.ctx.systemPrompt as typeof sp
    const dispose = scopedSP.section({ name: "x", order: 1, text: () => "x" })
    expect(changes.length).toBeGreaterThanOrEqual(1)
    dispose()
    expect(changes.length).toBeGreaterThanOrEqual(2)

    await scope.dispose()
  })

  it("system-prompt/assemble waterfall 可改写最终装配", async () => {
    const ctx = await createMiraContext()
    const sp = ctx.systemPrompt!
    sp.section({ name: "role", order: 10, text: () => "原始" })

    ctx.on("system-prompt/assemble", async (assembly, next) => {
      const result = await next()
      return { ...result, system: result.system + "\n插件附加" }
    })

    const out = await sp.assemble({ base: "" })
    expect(out.system).toContain("原始")
    expect(out.system).toContain("插件附加")
  })
})