import { describe, expect, test, afterEach } from "vitest"
import { invariantRegistry, registerDefaultInvariants, type InvariantContext } from "../invariants"
import { featureFlags } from "../config/flags"

function ctx(events: any[]): InvariantContext {
  return { sessionId: "s1", events }
}

function makeEvent(type: string, payload: unknown) {
  return { seq: 1, session_id: "s1", type, payload, timestamp: "", version: 1 }
}

afterEach(() => featureFlags.disable("invariants"))

describe("tool-call-result-pairing", () => {
  test("配对完整的会话无违规", () => {
    registerDefaultInvariants()
    const events = [
      makeEvent("message.appended", { content: [
        { type: "tool-call", id: "call_1" },
        { type: "tool-result", id: "call_1" },
      ] }),
    ]
    expect(invariantRegistry.runAll(ctx(events))).toEqual([])
  })

  test("未配对的 tool-call 报违规", () => {
    registerDefaultInvariants()
    featureFlags.enable("invariants")
    const events = [
      makeEvent("message.appended", { content: [
        { type: "tool-call", id: "call_1" },
      ] }),
    ]
    const violations = invariantRegistry.runAll(ctx(events))
    expect(violations.some((v) => v.includes("unpaired"))).toBe(true)
  })
})

describe("usage-non-decreasing", () => {
  test("usage 单调递增通过", () => {
    registerDefaultInvariants()
    const events = [
      makeEvent("message.appended", { totalTokens: 100 }),
      makeEvent("message.appended", { totalTokens: 300 }),
    ]
    expect(invariantRegistry.runAll(ctx(events))).toEqual([])
  })

  test("usage 回退报违规", () => {
    registerDefaultInvariants()
    featureFlags.enable("invariants")
    const events = [
      makeEvent("message.appended", { totalTokens: 300 }),
      makeEvent("message.appended", { totalTokens: 100 }),
    ]
    const violations = invariantRegistry.runAll(ctx(events))
    expect(violations.some((v) => v.includes("regressed"))).toBe(true)
  })
})

describe("InvariantRegistry", () => {
  test("register/unregister/list", () => {
    const reg = invariantRegistry
    reg.register({ name: "test-inv", check: () => null })
    expect(reg.list()).toContain("test-inv")
    reg.unregister("test-inv")
    expect(reg.list()).not.toContain("test-inv")
  })
})
