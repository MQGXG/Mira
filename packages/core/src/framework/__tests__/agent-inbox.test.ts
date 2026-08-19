/**
 * Inbox 投递模型测试（批 7）— 双边界 + followup/steer/inject + 事件 + keepInbox
 * 验证 PendingInputQueue 双边界语义与 Agent.inbox 集成。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Agent } from "../../agent/agent"
import { PendingInputQueue } from "../../agent/input-queue"
import { ToolRegistry } from "../../system/registry"
import { createMiraContext } from "../../framework/services"
import { make } from "../../shared/tool"
import { initPlatformPaths } from "../../config/paths"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { z } from "zod"

let llmCallCount = 0
vi.mock("../../llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../llm/client")>()
  return {
    ...actual,
    createLLMClient: vi.fn().mockImplementation(() => ({
      stream: vi.fn().mockImplementation(async function* () {
        llmCallCount++
        yield { type: "delta" as const, delta: `回复${llmCallCount}` }
        yield { type: "done" as const }
      }),
      complete: vi.fn().mockImplementation(async () => ({ content: "0" })),
    })),
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
  return { sessionID, workspace: "/tmp", model: "gpt-4", apiKey: "k", apiUrl: "http://x" }
}

describe("PendingInputQueue 双边界", () => {
  it("next-step（steer）优先于 next-turn（followup）", () => {
    const q = new PendingInputQueue()
    q.followup({ message: "A", type: "user" })
    q.followup({ message: "B", type: "user" })
    q.steer({ message: "S", type: "steer" })
    expect(q.claim()!.message).toBe("S")
    expect(q.claim()!.message).toBe("A")
    expect(q.claim()!.message).toBe("B")
    expect(q.claim()).toBeNull()
  })

  it("followup 队尾追加、steer 插队最前、inject 安静入队", () => {
    const q = new PendingInputQueue()
    q.followup({ message: "A", type: "user" })
    q.steer({ message: "S1", type: "steer" })
    q.steer({ message: "S2", type: "steer" })
    // 两次 steer → S2 最前
    expect(q.peek().map(i => i.message)).toEqual(["S2", "S1", "A"])
    // inject 入队不触发 claim 驱动
    q.inject({ message: "I", type: "user" })
    expect(q.peek().map(i => i.message)).toEqual(["S2", "S1", "A", "I"])
    // 边界过滤
    expect(q.peek("next-step").map(i => i.message)).toEqual(["S2", "S1"])
    expect(q.peek("next-turn").map(i => i.message)).toEqual(["A", "I"])
  })

  it("claim 可按边界定向取出；discard 按 id 丢弃", () => {
    const q = new PendingInputQueue()
    q.followup({ message: "A", type: "user" })
    const s1 = q.steer({ message: "S", type: "steer" })
    expect(q.claim("next-step")!.message).toBe("S")
    expect(q.claim("next-turn")!.message).toBe("A")
    q.followup({ message: "B", type: "user" })
    expect(q.discard(s1.id)).toBe(false) // 已消费
    const b = q.peek("next-turn")[0]
    expect(q.discard(b.id)).toBe(true)
    expect(q.hasPending()).toBe(false)
  })

  it("onSplice 回调记录 insert/delete 操作流", () => {
    const q = new PendingInputQueue()
    const ops: string[] = []
    q.onSplice = (op, kind) => ops.push(`${op.op}:${op.boundary}:${kind}`)
    q.followup({ message: "A", type: "user" })
    q.steer({ message: "S", type: "steer" })
    q.claim()
    q.discard(q.peek()[0].id)
    expect(ops).toEqual([
      "insert:next-turn:deliver",
      "insert:next-step:deliver",
      "delete:next-step:claim",
      "delete:next-turn:discard",
    ])
  })
})

describe("Agent inbox 集成", () => {
  beforeEach(() => {
    llmCallCount = 0
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-inbox-"))
    initPlatformPaths({ userData: tmp })
  })

  it("followup/steer/inject 触发 inserted 事件且可被消费", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })

    const inserted: string[] = []
    ctx.on("agent/inbox/inserted", (p) => inserted.push(`${p.boundary}:${p.item.message}`))

    const a = agent.followup("hello")
    const s = agent.steer("urgent")
    const i = agent.inject("quiet")
    expect(agent.pendingItems().map(x => x.message)).toEqual(["urgent", "hello", "quiet"])
    expect(inserted).toEqual(["next-turn:hello", "next-step:urgent", "next-turn:quiet"])
    expect(s.boundary).toBe("next-step")
    expect(i.boundary).toBe("next-turn")
  })

  it("run 消费 inbox 时 steer 优先（claim 事件触发）", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })

    const claimed: string[] = []
    ctx.on("agent/inbox/claimed", (p) => claimed.push(p.item.message))

    agent.followup("先")
    agent.steer("插队")
    for await (const _e of agent.run("追加", [], makeConfig(`inbox-${Date.now()}`))) { /* drain */ }
    // 首个消费的是 steer（next-step 优先）；无工具回合回复后 run 结束，其余保留
    expect(claimed[0]).toBe("插队")
    expect(agent.pendingItems().map(x => x.message)).toEqual(["先", "追加"])
  })

  it("cancel(keepInbox) 保留待办，下次 run 消费", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })

    // 先消费一个事件（run 进行中），steer 一条待办，cancel(keepInbox)
    const gen = agent.run("run1", [], makeConfig(`ki-${Date.now()}`))
    await gen.next()
    agent.steer("保留的活")
    agent.cancel("interrupt", { keepInbox: true })
    for await (const _e of gen) { /* drain */ }
    expect(agent.pendingItems().map(x => x.message)).toEqual(["保留的活"])

    // 下次 run：优先消费保留待办；新用户消息入队
    const claimed: string[] = []
    ctx.on("agent/inbox/claimed", (p) => claimed.push(p.item.message))
    for await (const _e of agent.run("run2", [], makeConfig(`ki-${Date.now()}`))) { /* drain */ }
    expect(claimed[0]).toBe("保留的活")
    // 无工具回合回复后 run 结束，run2 消息保留待下次
    expect(agent.pendingItems().map(x => x.message)).toEqual(["run2"])
  })

  it("spliced 事件落 session_events 可回放", async () => {
    const ctx = await createMiraContext()
    const registry = new ToolRegistry()
    registry.register(echoTool)
    const agent = new Agent(registry, undefined, undefined, undefined, { cordisCtx: ctx })
    const sessionID = `splice-${Date.now()}`

    const spliced: number[] = []
    ctx.on("agent/inbox/spliced", (p) => spliced.push(p.ops.length))

    agent.followup("hello")
    // 触发 run 建立 _lastSessionID 后再投递（落库需要 sessionID）
    for await (const _e of agent.run("hi", [], makeConfig(sessionID))) { /* drain */ }
    agent.followup("after-run")
    expect(spliced.length).toBeGreaterThanOrEqual(3)

    // 从事件表读回：应包含投递操作（run 的 user 消息 + after-run）
    await new Promise((r) => setTimeout(r, 100))
    const { getEventStore } = await import("../../session/event-store")
    const events = await getEventStore().getEvents(sessionID)
    const inboxEvents = events.filter((e) => e.type === "inbox.spliced")
    expect(inboxEvents.length).toBeGreaterThanOrEqual(1)
    const ops = inboxEvents.map((e) => e.payload).flatMap((p) => p.ops)
    expect(ops.some((op) => op.op === "insert" && op.item?.message === "after-run")).toBe(true)
    expect(ops.some((op) => op.op === "insert" && op.item?.message === "hi")).toBe(true)
  })
})