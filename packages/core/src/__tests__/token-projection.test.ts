import { describe, expect, test } from "vitest"
import { bucketsFrom, TokenUsageAccumulator, ContextPressureTracker, zeroBuckets } from "../session/token-projection"

describe("bucketsFrom", () => {
  test("无缓存时 uncachedInput = promptTokens", () => {
    const b = bucketsFrom({ promptTokens: 1000, completionTokens: 500 })
    expect(b.uncachedInputTokens).toBe(1000)
    expect(b.outputTokens).toBe(500)
    expect(b.cacheReadTokens).toBe(0)
    expect(b.cacheWriteTokens).toBe(0)
  })

  test("promptTokens 含缓存时拆出 uncachedInput", () => {
    // promptTokens = uncached + cacheRead + cacheWrite
    const b = bucketsFrom({ promptTokens: 15000, completionTokens: 500, cacheReadTokens: 10000, cacheWriteTokens: 2000 })
    expect(b.uncachedInputTokens).toBe(3000)
    expect(b.cacheReadTokens).toBe(10000)
    expect(b.cacheWriteTokens).toBe(2000)
  })

  test("负数 token 安全处理为 0", () => {
    const b = bucketsFrom({ promptTokens: -5, completionTokens: 0 })
    expect(b.uncachedInputTokens).toBe(0)
  })

  test("四桶互斥（DISJOINT）：uncached + read + write = promptTokens", () => {
    const b = bucketsFrom({ promptTokens: 1000, completionTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 300 })
    expect(b.uncachedInputTokens + b.cacheReadTokens + b.cacheWriteTokens).toBe(1000)
  })
})

describe("TokenUsageAccumulator", () => {
  test("累加多个不同 turn/step", () => {
    const acc = new TokenUsageAccumulator()
    acc.add({ turn: 1, step: 1, usage: { promptTokens: 1000, completionTokens: 200, cacheReadTokens: 500 } })
    acc.add({ turn: 1, step: 2, usage: { promptTokens: 800, completionTokens: 100 } })
    const totals = acc.totals
    // turn1/step1: uncached=500, out=200, read=500
    // turn1/step2: uncached=800, out=100, read=0
    expect(totals.uncachedInputTokens).toBe(1300)
    expect(totals.outputTokens).toBe(300)
    expect(totals.cacheReadTokens).toBe(500)
  })

  test("同 turn/step 重复上报（usage chunk 早到 + finish 最终值）替换不重复累加", () => {
    const acc = new TokenUsageAccumulator()
    acc.add({ turn: 1, step: 1, usage: { promptTokens: 1000, completionTokens: 200 } })
    // 同一 step 的最终上报（如 finish 携带精确 usage）
    acc.add({ turn: 1, step: 1, usage: { promptTokens: 1200, completionTokens: 210 } })
    const totals = acc.totals
    expect(totals.uncachedInputTokens).toBe(1200) // 1200 而非 2200
    expect(totals.outputTokens).toBe(210)
  })

  test("同 turn/step 相同值重复上报时不重复累加", () => {
    const acc = new TokenUsageAccumulator()
    acc.add({ turn: 1, step: 1, usage: { promptTokens: 1000, completionTokens: 200 } })
    acc.add({ turn: 1, step: 1, usage: { promptTokens: 1000, completionTokens: 200 } })
    expect(acc.totals.uncachedInputTokens).toBe(1000)
    expect(acc.totals.outputTokens).toBe(200)
  })

  test("reset 清空累计", () => {
    const acc = new TokenUsageAccumulator()
    acc.add({ turn: 1, step: 1, usage: { promptTokens: 1000, completionTokens: 100 } })
    acc.reset()
    expect(acc.totals).toEqual(zeroBuckets())
  })
})

describe("ContextPressureTracker", () => {
  test("记录最近一次实测 prompt 占用（覆盖旧值）", () => {
    const t = new ContextPressureTracker()
    t.record({ promptTokens: 8000 }, 128000)
    t.record({ promptTokens: 9500 })
    expect(t.pressure.pressureTokens).toBe(9500)
    expect(t.pressure.contextWindow).toBe(128000)
  })

  test("忽略无效值", () => {
    const t = new ContextPressureTracker()
    t.record({ promptTokens: 0 })
    expect(t.pressure.pressureTokens).toBeUndefined()
  })

  test("reset 清空", () => {
    const t = new ContextPressureTracker()
    t.record({ promptTokens: 5000 })
    t.reset()
    expect(t.pressure.pressureTokens).toBeUndefined()
  })
})
