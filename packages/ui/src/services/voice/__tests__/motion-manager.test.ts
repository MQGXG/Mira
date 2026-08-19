import { describe, it, expect, vi } from "vitest"
import { PetMotionManager, approach } from "../motion-manager"
import { motionPresetPlugin, idleBlinkPlugin, idleBreathPlugin, MOTION_PRESETS } from "../motion-plugins"

interface Collect {
  writes: Record<string, number>
  sink: (name: string, value: number) => void
}

function collect(): Collect {
  const writes: Record<string, number> = {}
  return {
    writes,
    sink: (name: string, value: number) => { writes[name] = value },
  }
}

describe("PetMotionManager", () => {
  it("register/unregister/list", () => {
    const m = new PetMotionManager()
    m.register(motionPresetPlugin()).register({ name: "x", idle: true, update() {} })
    expect(m.list()).toEqual(["motion:preset", "x"])
    m.register({ name: "x", idle: true, update() {} }) // 重名忽略
    expect(m.list()).toHaveLength(2)
    m.unregister("x")
    expect(m.list()).toEqual(["motion:preset"])
    expect(m.active).toBeNull()
  })

  it("trigger 按 kind 命中，写入延迟一次帧，stop 后为 null", () => {
    const m = new PetMotionManager()
    const { writes, sink } = collect()
    m.setSink(sink)
    m.register(motionPresetPlugin())
    m.trigger({ kind: "joy" })
    expect(m.active?.kind).toBe("joy")
    m.update(1 / 60)
    expect(writes.ParamMouthOpenY).toBeGreaterThan(0)
    m.stop()
    expect(m.active).toBeNull()
  })

  it("kind 不匹配不触发", () => {
    const m = new PetMotionManager()
    m.register({ ...motionPresetPlugin(), kind: "joy" })
    m.trigger({ kind: "boom" })
    expect(m.active).toBeNull()
  })

  it("durationMs 到期自动结束并回归 idle（参数回落到 0）", () => {
    const m = new PetMotionManager()
    const { writes } = collect()
    m.setSink((n, v) => { writes[n] = v })
    m.register(motionPresetPlugin())
    m.trigger({ kind: "nod", durationMs: 300 })
    for (let i = 0; i < 60; i++) m.update(1 / 60) // 1s > 300ms
    expect(m.active).toBeNull()
    expect(writes.ParamAngleX ?? 0).toBeLessThan(0.001)
  })

  it("兜底插件（kind 空）可接收任意动作", () => {
    const m = new PetMotionManager()
    const fn = vi.fn()
    m.register({ name: "catcher", idle: true, update() {}, trigger() { fn() } })
    m.trigger({ kind: "anything" })
    expect(fn).toHaveBeenCalled()
  })
})

describe("idle 插件", () => {
  it("眨眼插件初始处于 open 不写眼，timer 耗尽后闭眼期写参数", () => {
    const { writes, sink } = collect()
    const m = new PetMotionManager()
    m.setSink(sink)
    m.register(idleBlinkPlugin())
    m.update(1 / 60)
    expect(writes.ParamEyeLOpen).toBeUndefined() // open 期不写
    // 大步长推进：跳过随机 timer，进入 closing/opening
    m.update(60)
    m.update(60)
    expect(writes.ParamEyeLOpen).toBeDefined()
    expect(writes.ParamEyeLOpen).toBeLessThanOrEqual(1)
    expect(writes.ParamEyeLOpen).toBeGreaterThanOrEqual(0)
  })

  it("呼吸插件写入嘴部微幅", () => {
    const { writes, sink } = collect()
    const m = new PetMotionManager()
    m.setSink(sink)
    m.register(idleBreathPlugin())
    m.update(1 / 60)
    expect(writes.ParamMouthOpenY).toBeDefined()
    expect(writes.ParamMouthOpenY).toBeLessThan(0.1)
  })
})

describe("approach", () => {
  it("按 rate 逼近目标", () => {
    expect(approach(0, 1, 10, 0.1)).toBeGreaterThan(0)
    expect(approach(0.5, 0.5, 10, 0.1)).toBe(0.5)
    expect(approach(1, 0, 10, 0)).toBe(1) // delta 0 不动
  })
})

describe("MOTION_PRESETS", () => {
  it("包含常用的 joy / surprise", () => {
    expect(MOTION_PRESETS.joy.ParamMouthOpenY).toBe(0.35)
    expect(MOTION_PRESETS.surprise.ParamMouthOpenY).toBe(0.5)
  })
})