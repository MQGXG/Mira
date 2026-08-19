/**
 * session 溯源强化测试（批 9）— surface 折叠/替换 + 中断修复
 * 验证：foldSurface 折叠语义、判别函数、Projector 应用替换、repair 中断补全。
 */

import { describe, it, expect } from "vitest"
import {
  createMessageEvent,
  createMessageReplacedEvent,
  type SessionEvent,
} from "../../session/event-types"
import { foldSurface, isAppendSurfaceEvent, isReplacementSurfaceEvent, SurfaceManager } from "../../session/surface"
import { interruptedTurnClosers, TOOL_OUTCOME_UNKNOWN, toolInterruptionCode } from "../../session/repair"
import { Projector } from "../../session/projector"

function append(sessionId: string, role: "user" | "assistant" | "tool", content: string, seq: number): SessionEvent {
  return { ...createMessageEvent(sessionId, { role, content }), seq }
}

function replace(seq: number, role: "assistant", content: string, replaces: { start: number; end: number }): SessionEvent {
  return { ...createMessageReplacedEvent("s", { role, content, replaces }), seq }
}

describe("surface 折叠（批 9）", () => {
  it("append 事件追加到 surface 尾", () => {
    const e1 = append("s", "user", "你好", 1)
    const e2 = append("s", "assistant", "你好！", 2)
    const { nodes, replacements } = foldSurface([e1, e2])
    expect(nodes).toEqual([1, 2])
    expect(replacements).toEqual([])
  })

  it("替换事件折叠一段旧范围", () => {
    const e1 = append("s", "user", "Q", 1)
    const e2 = append("s", "assistant", "A1", 2)
    const e3 = replace(3, "assistant", "A2", { start: 2, end: 2 })
    const { nodes, replacements } = foldSurface([e1, e2, e3])
    // e1 保留，e2 被 e3 替换
    expect(nodes).toEqual([1, 3])
    expect(replacements).toEqual([{ seq: 3, start: 2, end: 2, shadowedSeqs: [2] }])
  })

  it("判别函数识别 append / replacement", () => {
    const ap = append("s", "user", "x", 1)
    const rep = replace(2, "assistant", "y", { start: 1, end: 1 })
    expect(isAppendSurfaceEvent(ap)).toBe(true)
    expect(isReplacementSurfaceEvent(ap)).toBe(false)
    expect(isAppendSurfaceEvent(rep)).toBe(false)
    expect(isReplacementSurfaceEvent(rep)).toBe(true)
  })

  it("SurfaceManager 增量折叠等价 foldSurface", () => {
    const e1 = append("s", "user", "Q", 1)
    const e2 = append("s", "assistant", "A1", 2)
    const e3 = replace(3, "assistant", "A2", { start: 2, end: 2 })
    const manager = new SurfaceManager([e1, e2, e3])
    const { nodes } = foldSurface([e1, e2, e3])
    expect([...manager.nodes]).toEqual(nodes)
    expect(manager.replaceGeneration).toBe(1)
  })
})

describe("Projector 替换投影（批 9）", () => {
  it("message.replaced 用新消息替换一段范围", () => {
    const e1 = append("s", "user", "Q", 1)
    const e2 = append("s", "assistant", "旧回答", 2)
    const e3 = replace(3, "assistant", "新回答", { start: 2, end: 2 })

    const projector = new Projector()
    const messages = projector.replay([e1, e2, e3])
    expect(messages.map(m => m.content)).toEqual(["Q", "新回答"])
  })

  it("替换多段（assistant + tool 折叠为一段）", () => {
    const e1 = append("s", "user", "Q", 1)
    const e2 = append("s", "assistant", "调工具", 2)
    const e3 = append("s", "tool", "结果", 3)
    const e4 = replace(4, "assistant", "最终回答", { start: 2, end: 3 })

    const projector = new Projector()
    const messages = projector.replay([e1, e2, e3, e4])
    expect(messages.map(m => m.content)).toEqual(["Q", "最终回答"])
  })
})

describe("中断修复（批 9）", () => {
  it("尾部含工具调用的 assistant 消息补未知结果", () => {
    const e1 = append("s", "user", "Q", 1)
    // Mira 的 assistant 含 tool-call 块（type: "tool-call"）
    const e2 = append("s", "assistant", JSON.stringify({ text: "", content: [{ type: "tool-call", toolName: "echo" }] }), 2)

    const closers = interruptedTurnClosers([e1, e2])
    expect(closers.length).toBe(2)
    const first = closers[0] as SessionEvent<"message.appended">
    expect(first.payload.role).toBe("tool")
    expect(toolInterruptionCode(first.payload.content)).toBe(TOOL_OUTCOME_UNKNOWN)
    // seq 延续
    expect(closers[0].seq).toBe(3)
    expect(closers[1].seq).toBe(4)
  })

  it("已平衡日志不产生合成事件", () => {
    const e1 = append("s", "user", "Q", 1)
    const e2 = append("s", "assistant", "回答", 2)
    const closers = interruptedTurnClosers([e1, e2])
    expect(closers).toEqual([])
  })
})