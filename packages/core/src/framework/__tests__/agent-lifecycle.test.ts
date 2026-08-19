/**
 * Agent 生命周期测试 — cancel / whenIdle / runMaintenance / agent/status
 * 验证批 5（A）对齐 dsh Agent 生命周期控制的语义。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Agent } from "../../agent/agent"
import { ToolRegistry } from "../../system/registry"
import { createMiraContext } from "../../framework/services"
import { make } from "../../shared/tool"
import { initPlatformPaths } from "../../config/paths"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { z } from "zod"

// mock LLM：全局计数——第 1 次调用返回工具调用，之后返回纯文本结束
let llmCallCount = 0
vi.mock("../../llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm/client")>()
  return {
    ...actual,
    createLLMClient: vi.fn().mockImplementation(() => {
      return {
        stream: vi.fn().mockImplementation(async function* () {
          llmCallCount++
          if (llmCallCount === 1) {
            yield { type: "tool_call" as const, toolCall: { id: "t1", name: "echo", arguments: JSON.stringify({ text: "hi" }), index: 0 } }
          } else {
            yield { type: "delta" as const, delta: "完成" }
          }
          yield { type: "done" as const }
        }),
        complete: vi.fn().mockImplementation(async () => ({ content: "0" })),
      }
    }),
  }
})

const echoTool = make({
  name: "echo",
  description: "echo tool",
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.string(),
  async execute(input: { text: string }) {
    return { success: true, output: input.text }
  },
})

function makeConfig(sessionID: string) {
  return {
    sessionID,
    workspace: "/tmp",
    model: "gpt-4",
    apiKey: "k",
    apiUrl: "http://x",
  }
}

function makeAgent(ctx: Awaited<ReturnType<typeof createMiraContext>>): { agent: Agent; registry: ToolRegistry } {
  const registry = new ToolRegistry()
  registry.register(echoTool)
  const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
  return { agent, registry }
}

describe("Agent 生命周期（批 5）", () => {
  beforeEach(() => {
    llmCallCount = 0
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-lifecycle-"))
    initPlatformPaths({ userData: tmp })
  })

  it("cancel 中断当前 run 并保持 agent 状态可再运行", async () => {
    const ctx = await createMiraContext()
    const { agent } = makeAgent(ctx)
    const config = makeConfig(`cancel-${Date.now()}`)

    const gen = agent.run("hi", [], config)
    // 消费一个事件后取消（模拟外部中断）
    await gen.next()
    expect(agent.status).toBe("running")

    agent.cancel("user-interrupt")
    let sawFinish = false
    let sawStopped = false
    for await (const e of gen) {
      if (e.type === "finish") {
        sawFinish = true
        if (e.reason === "stopped") sawStopped = true
      }
    }
    expect(sawFinish).toBe(true)
    expect(sawStopped).toBe(true)
    expect(agent.cancelCause).toBe("user-interrupt")
    expect(agent.status).toBe("idle")

    // 取消后可再次运行
    llmCallCount = 0
    let sawFinish2 = false
    for await (const e of agent.run("hi again", [], config)) {
      if (e.type === "finish") sawFinish2 = true
    }
    expect(sawFinish2).toBe(true)
  })

  it("无活动时 cancel 为空操作", async () => {
    const ctx = await createMiraContext()
    const { agent } = makeAgent(ctx)
    expect(agent.status).toBe("idle")
    agent.cancel("nope")
    expect(agent.cancelCause).toBeNull()
    expect(agent.status).toBe("idle")
  })

  it("whenIdle 在 run 结束后 resolve", async () => {
    const ctx = await createMiraContext()
    const { agent } = makeAgent(ctx)
    const config = makeConfig(`idle-${Date.now()}`)

    let idleResolved = false
    const idlePromise = agent.whenIdle().then(() => { idleResolved = true })
    expect(agent.status).toBe("idle")
    // 无活动时立即 resolve
    await idlePromise
    expect(idleResolved).toBe(true)

    // run 进行中调用 whenIdle → 在 run 结束后 resolve
    let resolvedAfterRun = false
    const gen = agent.run("hi", [], config)
    await gen.next()
    const idlePromise2 = agent.whenIdle().then(() => { resolvedAfterRun = true })
    // 消费全部事件直至 run 结束（whenIdle 在 run 静默后解析）
    for await (const _e of gen) { /* drain */ }
    await idlePromise2
    expect(resolvedAfterRun).toBe(true)
    expect(agent.status).toBe("idle")
  })

  it("runMaintenance 与 turn 互斥；空闲期可执行", async () => {
    const ctx = await createMiraContext()
    const { agent } = makeAgent(ctx)
    const config = makeConfig(`maint-${Date.now()}`)

    // 空闲期可执行
    let ran = false
    await agent.runMaintenance(async () => { ran = true })
    expect(ran).toBe(true)

    // turn 进行中同步抛错
    const gen = agent.run("hi", [], config)
    await gen.next()
    expect(agent.status).toBe("running")
    let threw = false
    try {
      agent.runMaintenance(async () => {})
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // 消费全部事件直至 run 结束
    for await (const _e of gen) { /* drain */ }
  })

  it("agent/status 事件在 idle ⇄ running 转换时触发", async () => {
    const ctx = await createMiraContext()
    const { agent } = makeAgent(ctx)
    const config = makeConfig(`status-${Date.now()}`)

    const statuses: string[] = []
    ctx.on("agent/status", (payload) => {
      statuses.push(payload.status)
    })

    // 消费全部事件直至 run 结束
    for await (const _e of agent.run("hi", [], config)) { /* drain */ }
    expect(statuses).toContain("running")
    expect(statuses).toContain("idle")
    // 首事件 running、末事件 idle
    expect(statuses[0]).toBe("running")
    expect(statuses[statuses.length - 1]).toBe("idle")
  })
})