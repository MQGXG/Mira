import { describe, it, expect } from "vitest"
import { LipSyncEngine, LIP_KEYS } from "../lip-sync"

describe("LipSyncEngine", () => {
  it("静音输入归零口型（不产生抖动）", () => {
    const engine = new LipSyncEngine()
    const out = engine.update({ volume: 0, timeMs: 0 })
    expect(out.mouthOpen).toBe(0)
    for (const k of LIP_KEYS) expect(out.weights[k]).toBe(0)
  })

  it("响度驱动口型打开，且不超过 cap", () => {
    const engine = new LipSyncEngine()
    let out = engine.update({ volume: 1, timeMs: 0 })
    for (let i = 1; i <= 30; i++) {
      out = engine.update({ volume: 1, timeMs: i * 16.67 })
    }
    // winner 口型打开，开度合并值在 0..1 上限内（受平滑建立影响）
    expect(out.mouthOpen).toBeGreaterThan(0)
    expect(out.mouthOpen).toBeLessThanOrEqual(1)
    expect(out.winner).toBeDefined()
  })

  it("默认选项下轰炸 60fps 一帧后 mouthOpen 接近上限但未超", () => {
    // 持续高音量下持续 tick，口型应近似稳定在上限 0.7 附近且不抖动超过 1
    const engine = new LipSyncEngine()
    let last = 0
    for (let i = 1; i <= 60; i++) {
      const out = engine.update({ volume: 1, timeMs: i * 16.67 })
      last = out.mouthOpen
    }
    expect(last).toBeGreaterThanOrEqual(0.5)
    expect(last).toBeLessThanOrEqual(1)
  })

  it("静音后口型平滑回零（非瞬断）", () => {
    const engine = new LipSyncEngine()
    // 先开口
    for (let i = 1; i <= 30; i++) engine.update({ volume: 1, timeMs: i * 16.67 })
    const opened = engine.update({ volume: 1, timeMs: 30 * 16.67 })
    expect(opened.mouthOpen).toBeGreaterThan(0.2)
    // 突然静音
    for (let i = 1; i <= 10; i++) engine.update({ volume: 0, timeMs: (30 + i) * 16.67 })
    const closed = engine.update({ volume: 0, timeMs: 40 * 16.67 })
    expect(closed.mouthOpen).toBeLessThan(opened.mouthOpen)
    expect(closed.mouthOpen).toBeLessThan(0.1)
  })
})