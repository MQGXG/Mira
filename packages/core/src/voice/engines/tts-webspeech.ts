/**
 * Web Speech TTS 引擎 — 浏览器系统语音
 */

import type { TTSEngine, VoiceEngineDef } from "../types"

export const DEFAULT_WEBSPEECH_TTS_LANG = "zh-CN"

/** 创建一个 Web Speech TTS 引擎实例 */
export function createWebSpeechTTSEngine(def: VoiceEngineDef): TTSEngine {
  const lang = (def.params?.language as string | undefined) || DEFAULT_WEBSPEECH_TTS_LANG
  const rate = (def.params?.rate as number | undefined) ?? 1
  const pitch = (def.params?.pitch as number | undefined) ?? 1
  let current: SpeechSynthesisUtterance | null = null

  return {
    type: "webspeech",
    isAvailable: () => typeof window !== "undefined" && "speechSynthesis" in window,
    speak(text, options) {
      return new Promise<void>((resolve) => {
        if (!text.trim()) { resolve(); return }
        const synth = window.speechSynthesis
        synth.cancel()
        const utter = new SpeechSynthesisUtterance(text)
        utter.lang = lang
        utter.rate = rate
        utter.pitch = pitch
        current = utter
        options?.onStart?.()
        utter.onend = () => { current = null; options?.onEnd?.(); resolve() }
        utter.onerror = () => { current = null; options?.onEnd?.(); resolve() }
        synth.speak(utter)
      })
    },
    stop() {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel()
      }
      current = null
    },
  }
}