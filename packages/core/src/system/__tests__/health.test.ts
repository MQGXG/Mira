import { describe, it, expect } from "vitest"
import { rendererBootWindow } from "../health"

describe("rendererBootWindow（boot 超时判定）", () => {
  it("未超时返回 false", () => {
    expect(rendererBootWindow(Date.now() - 10_000, Date.now(), 30_000)).toBe(false)
  })
  it("超时返回 true", () => {
    expect(rendererBootWindow(Date.now() - 31_000, Date.now(), 30_000)).toBe(true)
  })
  it("30s 临界点不超时", () => {
    const now = Date.now()
    expect(rendererBootWindow(now - 30_000, now, 30_000)).toBe(false)
  })
})
