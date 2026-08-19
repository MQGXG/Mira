import { describe, it, expect } from "vitest"
import { classifyStep, isTerminal, isRecovery, isPlainContinue, MAX_STEPS_WARNING, MAX_STEPS_REACHED } from "../agent/turn-classifier"
import type { LLMMessage } from "../llm/client"

const text = (content: string): LLMMessage => ({ role: "assistant", content })
const container = (parts: Array<{ type: string; text?: string; toolName?: string }>): LLMMessage => ({
  role: "assistant", content: parts as LLMMessage["content"],
})

function ctx(overrides: Partial<Parameters<typeof classifyStep>[1]> = {}) {
  return {
    step: 1, maxSteps: 10, ngramBuffer: [], activeGoal: null,
    toolErrorCount: 0, toolCallCount: 0,
    ...overrides,
  }
}

describe("classifyStep — max-turns 软关闭", () => {
  it("step 达到 maxSteps → max-turns", () => {
    const r = classifyStep([text("hello")], ctx({ step: 20, maxSteps: 20 }))
    expect(r.type).toBe("max-turns")
    expect(isTerminal(r)).toBe(true)
  })

  it("step 未达上限且纯文本 → completed", () => {
    const r = classifyStep([text("hello")], ctx({ step: 2, maxSteps: 20 }))
    expect(r.type).toBe("completed")
  })

  it("有工具调用 → continue", () => {
    const r = classifyStep([container([{ type: "tool-call", toolName: "bash" }])], ctx({ step: 2, maxSteps: 20 }))
    expect(r.type).toBe("continue")
    expect(isPlainContinue(r)).toBe(true)
  })
})

describe("classifyStep — 恢复动作", () => {
  it("空输出（只思考）→ retry", () => {
    const r = classifyStep([container([{ type: "text", text: "" }])], ctx())
    expect(r.type).toBe("retry")
    expect(isRecovery(r)).toBe(true)
  })

  it("finish=length → auto-continue", () => {
    const m = container([{ type: "text", text: "part1" }])
    ;(m as any).finish = "length"
    const r = classifyStep([m], ctx())
    expect(r.type).toBe("auto-continue")
  })

  it("工具拒绝但需要工具 → tool-suggest", () => {
    const r = classifyStep([text("我不需要调用任何工具")], ctx({ userIntent: "requires_tool" }))
    expect(r.type).toBe("tool-suggest")
  })
})

describe("MAX_STEPS 提示语", () => {
  it("WARNING 提示最后轮、工具将不可用", () => {
    expect(MAX_STEPS_WARNING).toContain("最后一轮")
    expect(MAX_STEPS_WARNING).toContain("工具")
  })

  it("REACHED 强制文本收尾", () => {
    expect(MAX_STEPS_REACHED).toContain("MAXIMUM STEPS REACHED")
    expect(MAX_STEPS_REACHED).toContain("tool calls")
  })
})