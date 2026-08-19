/**
 * 事件面补齐测试（批 6）— agent/error / agent/request-error / tools/execute
 * 验证三个事件在真实 Agent.run 循环中触发。
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

// mock LLM：call#1 → 工具调用；call#2+ → 纯文本结束（Agent 循环每步新建 client，计数必须模块级）
let llmCallCount = 0
let llmMode: "ok" | "error" | "fallback" = "ok"
vi.mock("../../llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm/client")>()
  return {
    ...actual,
    createLLMClient: vi.fn().mockImplementation(() => {
      return {
        stream: vi.fn().mockImplementation(async function* () {
          llmCallCount++
          if (llmMode === "error") {
            yield { type: "error" as const, error: { message: "internal server error" } }
            return
          }
          if (llmMode === "fallback") {
            yield { type: "error" as const, error: { message: "rate limit exceeded" } }
            return
          }
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

function makeConfig(sessionID: string, extra: Record<string, unknown> = {}) {
  return {
    sessionID,
    workspace: "/tmp",
    model: "gpt-4",
    apiKey: "k",
    apiUrl: "http://x",
    ...extra,
  }
}

describe("事件面补齐（批 6）", () => {
  beforeEach(() => {
    llmCallCount = 0
    llmMode = "ok"
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-events6-"))
    initPlatformPaths({ userData: tmp })
  })

  it("tools/execute 包裹工具 body 且可改写结果", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)

    const execs: Array<{ id: string; name: string; args: Record<string, unknown> }> = []
    ctx.on("tools/execute", async (exec, next) => {
      execs.push(exec)
      const result = await next()
      return { ...result, output: "改写:" + result.output }
    })

    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    let sawRewritten = false
    for await (const e of agent.run("hi", [], makeConfig(`exec-${Date.now()}`))) {
      if (e.type === "tool_result" && e.result?.output === "改写:hi") sawRewritten = true
    }
    expect(execs.length).toBeGreaterThanOrEqual(1)
    expect(execs[0]).toMatchObject({ name: "echo", args: { text: "hi" } })
    expect(sawRewritten).toBe(true)
  })

  it("agent/error 在 LLM 流错误时触发", async () => {
    llmMode = "error"
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)

    const errors: string[] = []
    ctx.on("agent/error", (payload) => {
      errors.push(String(payload.error))
    })

    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    for await (const _e of agent.run("hi", [], makeConfig(`err-${Date.now()}`))) { /* drain */ }
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0]).toContain("internal server error")
  })

  it("agent/request-error 在降级链耗尽时触发", async () => {
    llmMode = "fallback"
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)

    const reqErrors: Array<{ attempt: number; provider: string }> = []
    ctx.on("agent/request-error", (payload) => {
      reqErrors.push({ attempt: payload.attempt, provider: payload.provider || "" })
    })

    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    const config = makeConfig(`reqerr-${Date.now()}`, {
      fallbacks: [{ provider: "fallback", model: "x", apiKey: "k", apiUrl: "http://y" }],
    })
    for await (const _e of agent.run("hi", [], config)) { /* drain */ }
    // primary(attempt 1) 与 fallback(attempt 2) 均失败 → 两次通知
    expect(reqErrors.length).toBeGreaterThanOrEqual(2)
    expect(reqErrors[0].attempt).toBe(1)
    expect(reqErrors[1].attempt).toBe(2)
    expect(reqErrors[0].provider).toBe("openai")
  })
})