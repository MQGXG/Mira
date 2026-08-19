import { describe, it, expect, vi } from "vitest"

// ── 全局 stub：core webspeech/kokoro 引擎依赖浏览器 API ──────────
vi.stubGlobal("AudioContext", class {
  destination: unknown = {}
  createBuffer() { return { copyToChannel: () => {} } }
  createBufferSource() { return { connect: () => {}, start: () => {}, end: null } }
})

vi.stubGlobal("SpeechSynthesisUtterance", class {
  lang = ""; rate = 1; pitch = 1; onend: (() => void) | null = null
})

vi.stubGlobal("speechSynthesis", {
  speak(u: { onend?: () => void }) { u.onend?.() },
  cancel: vi.fn(),
})
;(globalThis as any).window = {
  speechSynthesis: (globalThis as any).speechSynthesis,
  AudioContext: (globalThis as any).AudioContext,
}

import { createTTSEngine, createLocalEngine, createWebSpeechEngine, createDefaultTTSEngine } from "../tts"

describe("TTS 引擎门面（薄代理 core）", () => {
  it("createTTSEngine('webspeech') 返回 webspeech 引擎", () => {
    expect(createTTSEngine("webspeech").type).toBe("webspeech")
  })

  it("createTTSEngine('local') 返回 local 引擎", () => {
    expect(createTTSEngine("local").type).toBe("local")
  })

  it("createLocalEngine 类型为 local", () => {
    expect(createLocalEngine().type).toBe("local")
  })

  it("createWebSpeechEngine 类型为 webspeech", () => {
    expect(createWebSpeechEngine().type).toBe("webspeech")
  })

  it("createDefaultTTSEngine 默认 webspeech", () => {
    expect(createDefaultTTSEngine().type).toBe("webspeech")
  })

  it("webspeech 引擎 speak 走 speechSynthesis.speak", async () => {
    const speakSpy = vi.spyOn(globalThis.speechSynthesis, "speak")
    const engine = createWebSpeechEngine()
    await engine.speak("你好")
    expect(speakSpy).toHaveBeenCalled()
  })

  it("stop() 不抛异常", () => {
    expect(() => createLocalEngine().stop()).not.toThrow()
    expect(() => createWebSpeechEngine().stop()).not.toThrow()
  })
})
