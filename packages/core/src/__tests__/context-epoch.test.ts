import { describe, it, expect } from "vitest"
import { ContextEpochTracker } from "../session/context-epoch"

describe("ContextEpochTracker", () => {
  it("首次 begin 创建 epoch=1", () => {
    const tracker = new ContextEpochTracker()
    const epoch = tracker.begin("s1", "baseline", 10)
    expect(epoch.epoch).toBe(1)
    expect(epoch.sessionID).toBe("s1")
    expect(epoch.baselineSeq).toBe(10)
  })

  it("连续 begin 递增 epoch 序号", () => {
    const tracker = new ContextEpochTracker()
    tracker.begin("s1", "baseline", 10)
    const epoch2 = tracker.begin("s1", "baseline", 20)
    expect(epoch2.epoch).toBe(2)
  })

  it("shouldBegin 在首次时返回 true", () => {
    const tracker = new ContextEpochTracker()
    expect(tracker.shouldBegin("s1", 5)).toBe(true)
  })

  it("shouldBegin 在事件跨阈值时返回 true", () => {
    const tracker = new ContextEpochTracker()
    tracker.begin("s1", "baseline", 10)
    expect(tracker.shouldBegin("s1", 59, false, 50)).toBe(false)
    expect(tracker.shouldBegin("s1", 60, false, 50)).toBe(true)
  })

  it("shouldBegin 在基线变化时立即返回 true", () => {
    const tracker = new ContextEpochTracker()
    tracker.begin("s1", "baseline", 10)
    expect(tracker.shouldBegin("s1", 11, true)).toBe(true)
  })

  it("delta 计算当前 epoch 后的增量事件数", () => {
    const tracker = new ContextEpochTracker()
    tracker.begin("s1", "baseline", 10)
    expect(tracker.delta("s1", 25)).toBe(15)
    expect(tracker.delta("s1", 8)).toBe(0)
  })

  it("history 只保留最近 5 个 epoch", () => {
    const tracker = new ContextEpochTracker()
    for (let i = 0; i < 8; i++) {
      tracker.begin("s1", "baseline", i * 10)
    }
    const history = tracker.history("s1")
    expect(history.length).toBe(5)
    expect(history[0].epoch).toBe(4)
    expect(history[history.length - 1].epoch).toBe(8)
  })

  it("clear 清空指定会话", () => {
    const tracker = new ContextEpochTracker()
    tracker.begin("s1", "b", 0)
    tracker.clear("s1")
    expect(tracker.current("s1")).toBeUndefined()
  })

  it("toJSON / fromJSON 往返恢复", () => {
    const tracker = new ContextEpochTracker()
    tracker.begin("s1", "baseline", 10, { base: { hash: "h1", updatedAt: 1 } })

    const restored = ContextEpochTracker.fromJSON(tracker.toJSON())
    const epoch = restored.current("s1")
    expect(epoch?.epoch).toBe(1)
    expect(epoch?.baselineSeq).toBe(10)
    expect(epoch?.sourceSnapshot?.base?.hash).toBe("h1")
    // 恢复后应能正确判断阈值
    expect(restored.shouldBegin("s1", 59, false, 50)).toBe(false)
    expect(restored.shouldBegin("s1", 60, false, 50)).toBe(true)
  })
})
