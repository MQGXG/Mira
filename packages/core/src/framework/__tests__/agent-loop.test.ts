/**
 * Agent 循环插件扩展点测试
 * 验证：Agent 注入 Cordis Context 后，agent/pre-step waterfall 事件被插件触发
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Agent } from "../../agent/agent"
import { ToolRegistry } from "../../system/registry"
import { createMiraContext } from "../services"
import { initPlatformPaths } from "../../config/paths"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm/client")>()
  return {
    ...actual,
    createLLMClient: vi.fn().mockImplementation(() => ({
      stream: vi.fn().mockImplementation(async function* () {
        yield { type: "delta" as const, delta: "插件循环回复" }
        yield { type: "done" as const }
      }),
      complete: vi.fn().mockImplementation(async () => ({ content: "0" })),
    })),
  }
})

describe("Agent 循环插件扩展点", () => {
  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-agent-loop-"))
    initPlatformPaths({ userData: tmp })
  })

  it("应注入 cordisCtx（setMiraContext / 构造注入）", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    const agent = new Agent(registry)
    expect(agent.getMiraContext()).toBeNull()
    agent.setMiraContext(ctx)
    expect(agent.getMiraContext()).toBe(ctx)
  })

  it("应通过 deps.cordisCtx 构造注入", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    expect(agent.getMiraContext()).toBe(ctx)
  })

  it("agent/pre-step 事件应在 Agent.run 时触发并可改写模型所见", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()

    // 插件：监听 agent/pre-step，注入系统提示并记录调用
    const calls: number[] = []
    ctx.on("agent/pre-step", (messages, next) => {
      calls.push(messages.length)
      ;(messages as unknown[]).push({ role: "system", content: "插件注入的提示" } as never)
      return next()
    })

    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    const config = {
      sessionID: `loop-${Date.now()}`,
      workspace: "/tmp",
      model: "gpt-4",
      apiKey: "k",
      apiUrl: "http://x",
    }
    for await (const _e of agent.run("你好", [], config)) {}
    // pre-step 至少触发一次（内层循环每步请求前触发）
    expect(calls.length).toBeGreaterThan(0)
  })

  it("未注入 Context 时循环行为不变（向后兼容）", async () => {
    const ctx = await createMiraContext()
    const calls: number[] = []
    ctx.on("agent/pre-step", (messages, next) => {
      calls.push(messages.length)
      return next()
    })
    const registry = new ToolRegistry()
    const agent = new Agent(registry) // 未注入 ctx
    const config = {
      sessionID: `noloop-${Date.now()}`,
      workspace: "/tmp",
      model: "gpt-4",
      apiKey: "k",
      apiUrl: "http://x",
    }
    for await (const _e of agent.run("你好", [], config)) {}
    // 未注入 ctx：事件不会被触发
    expect(calls.length).toBe(0)
  })
})
