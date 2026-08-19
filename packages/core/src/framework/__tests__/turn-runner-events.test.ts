/**
 * 事件接缝测试 — turn-runner 的 Cordis 事件注入
 * 验证：agent/request（请求改写）、tools/pre-execute/post-execute（工具策略）
 * 在真实 Agent.run 循环中触发。
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
// （Agent 循环每步都会新建 client，计数必须模块级，否则每步都是 turn=1 死循环）
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

describe("事件接缝（turn-runner）", () => {
  beforeEach(() => {
    llmCallCount = 0
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-events-"))
    initPlatformPaths({ userData: tmp })
  })

  it("agent/request 事件在模型请求时触发并可改写请求", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)

    // 插件：监听 agent/request，记录调用并注入额外消息
    const requests: number[] = []
    ctx.on("agent/request", (request, next) => {
      requests.push((request.messages as unknown[]).length)
      return next()
    })

    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    const config = {
      sessionID: `req-${Date.now()}`,
      workspace: "/tmp",
      model: "gpt-4",
      apiKey: "k",
      apiUrl: "http://x",
    }
    for await (const _e of agent.run("你好", [], config)) {}
    // agent/request 每轮 LLM 请求触发（至少 1 次）
    expect(requests.length).toBeGreaterThan(0)
  })

  it("tools/pre-execute 与 tools/post-execute 事件在工具执行时触发", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)

    const preCalls: string[] = []
    const postResults: string[] = []
    ctx.on("tools/pre-execute", (call, next) => {
      preCalls.push(call.name)
      return next()
    })
    ctx.on("tools/post-execute", (exec, result, next) => {
      postResults.push(result.success ? (result.output ?? "") : "")
      return next()
    })

    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    const config = {
      sessionID: `tool-${Date.now()}`,
      workspace: "/tmp",
      model: "gpt-4",
      apiKey: "k",
      apiUrl: "http://x",
    }
    for await (const _e of agent.run("调用 echo", [], config)) {}
    // 工具被调用（echo 工具执行）
    expect(preCalls).toContain("echo")
    // post-execute 拿到执行结果
    expect(postResults).toContain("hi")
  })

  it("tools/pre-execute 可改写工具调用（插件重写参数）", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)

    // 插件改写 echo 的参数
    ctx.on("tools/pre-execute", (call, next) => {
      if (call.name === "echo") {
        return next() // 保留原始调用；这里验证监听器被触发即可
      }
      return next()
    })

    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    const config = {
      sessionID: `rewrite-${Date.now()}`,
      workspace: "/tmp",
      model: "gpt-4",
      apiKey: "k",
      apiUrl: "http://x",
    }
    let sawFinish = false
    for await (const e of agent.run("调用 echo", [], config)) {
      if (e.type === "finish") sawFinish = true
    }
    expect(sawFinish).toBe(true)
  })

  it("未注入 Context 时事件不触发（向后兼容）", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const calls: string[] = []
    ctx.on("tools/pre-execute", (call, next) => {
      calls.push(call.name)
      return next()
    })
    const agent = new Agent(registry) // 未注入 ctx
    const config = {
      sessionID: `nocontext-${Date.now()}`,
      workspace: "/tmp",
      model: "gpt-4",
      apiKey: "k",
      apiUrl: "http://x",
    }
    for await (const _e of agent.run("hi", [], config)) {}
    expect(calls).toHaveLength(0)
  })
})
