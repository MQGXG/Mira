/**
 * tools 四阶段调度器测试（批 10）
 * 验证：prepare→dispatch→finalize→finish 顺序、事件时机、错误码、取消传播、守卫门。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { createMiraContext } from "../../framework/services"
import { make, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_NOT_FOUND } from "../../shared/tool"
import { ToolRegistry } from "../../system/registry"
import { initPlatformPaths } from "../../config/paths"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { z } from "zod"
import type { MiraToolService } from "../../services/tools"

const echoTool = make({
  name: "echo",
  description: "echo",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.string(),
  async execute(input: { text: string }) {
    return { success: true, output: input.text }
  },
})

function toolCtx(over = {}) {
  return {
    sessionID: "s",
    workspace: "/tmp",
    mode: "assistant",
    agent: "a",
    assistantMessageID: "m",
    toolCallID: "t1",
    ...over,
  }
}

describe("tools 四阶段调度器（批 10）", () => {
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-t10-"))
    initPlatformPaths({ userData: tmp })
  })

  it("tools/execute → post-execute → tools/result 有序触发（pre-execute 由 turn-runner 处理）", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    ;(ctx.tools as MiraToolService).registry.register(echoTool)

    const order: string[] = []
    ctx.on("tools/execute", (_e, next) => { order.push("exec"); return next() })
    ctx.on("tools/post-execute", (_e, r, next) => { order.push("post:" + (r.output ?? "")); return next() })
    ctx.on("tools/result", () => { order.push("result") })

    const result = await (ctx.tools as MiraToolService).execute("echo", { text: "hi" }, toolCtx())
    expect(result.success).toBe(true)
    expect(order).toEqual(["exec", "post:hi", "result"])
  })

  it("未知工具返回 TOOL_NOT_FOUND 错误码且不走 finalize", async () => {
    const ctx = await createMiraContext()
    const order: string[] = []
    ctx.on("tools/post-execute", (_e, r, next) => { order.push("post"); return next() })

    const result = await (ctx.tools as MiraToolService).execute("nope", {}, toolCtx())
    expect(result.success).toBe(false)
    expect(result.code).toBe(TOOL_NOT_FOUND)
    // 未知工具直接 finish，不触发 post-execute
    expect(order).toEqual([])
  })

  it("dispatch 前已取消返回 ABORTED_BEFORE_DISPATCH", async () => {
    const ctx = await createMiraContext()
    const ac = new AbortController()
    ac.abort()
    const result = await (ctx.tools as MiraToolService).executeScheduled(
      { id: "t1", name: "echo", args: {}, signal: ac.signal },
      toolCtx(),
    )
    expect(result.code).toBe(TOOL_ABORTED_BEFORE_DISPATCH)
    expect(result.aborted).toBe(true)
  })

  it("tools/execute 事件可完全接管工具 body（插件实现）", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    ;(ctx.tools as MiraToolService).registry.register(echoTool)

    // 插件接管 echo，不调用 next()，返回自定义结果
    ctx.on("tools/execute", () => ({ success: true, output: "被插件接管" }))

    const result = await (ctx.tools as MiraToolService).execute("echo", { text: "hi" }, toolCtx())
    expect(result.output).toBe("被插件接管")
  })

  it("守卫门在 prepare 阶段阻断（返回拒绝原因）", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    ;(ctx.tools as MiraToolService).registry.register(echoTool)
    ;(ctx.tools as MiraToolService).guard(() => "不允许使用 echo")

    const result = await (ctx.tools as MiraToolService).execute("echo", { text: "hi" }, toolCtx())
    expect(result.success).toBe(false)
    expect(result.error).toContain("不允许使用 echo")
  })

  it("registryOverride 支持 agent 专用注册表", async () => {
    const ctx = await createMiraContext()
    // 服务 registry 不含 echo，但 override 含
    const agentRegistry = new ToolRegistry()
    agentRegistry.register(echoTool)

    const result = await (ctx.tools as MiraToolService).executeScheduled(
      { id: "t1", name: "echo", args: { text: "hi" } },
      toolCtx(),
      agentRegistry,
    )
    expect(result.success).toBe(true)
    expect(result.output).toBe("hi")
  })
})