import { describe, it, expect } from "vitest"
import { VoiceSessionManager } from "../voice/voice-session"

describe("VoiceSessionManager turn generation", () => {
  it("每次 speech_start 世代递增", () => {
    const vm = new VoiceSessionManager()
    expect(vm.getGeneration()).toBe(0)
    // 模拟 VAD speech_start
    ;(vm as any).handleSpeechStart()
    expect(vm.getGeneration()).toBe(1)
    ;(vm as any).handleSpeechStart()
    expect(vm.getGeneration()).toBe(2)
  })

  it("isCurrentGeneration 拒绝旧世代", () => {
    const vm = new VoiceSessionManager()
    expect(vm.isCurrentGeneration(0)).toBe(true)
    ;(vm as any).handleSpeechStart() // gen=1
    expect(vm.isCurrentGeneration(0)).toBe(false)
    expect(vm.isCurrentGeneration(1)).toBe(true)
    expect(vm.isCurrentGeneration(undefined)).toBe(true) // 无标记事件默认放行
  })

  it("事件携带 generation", () => {
    const vm = new VoiceSessionManager()
    let ev: any = null
    vm.on("state_change", (e: any) => { ev = e })
    ;(vm as any).handleSpeechStart()
    expect(ev?.generation).toBe(1)
  })
})