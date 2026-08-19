/**
 * Web Speech STT 引擎 — 浏览器 Web Speech API（云端，降级用）
 */

import type { STTEngine, VoiceEngineDef } from "../types"

export const DEFAULT_WEBSpeech_STT_LANG = "zh-CN"

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | undefined {
  if (typeof window === "undefined") return undefined
  return (
    (window as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ||
    (window as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition
  )
}

/** 创建一个 Web Speech STT 引擎实例 */
export function createWebSpeechSTTEngine(def: VoiceEngineDef): STTEngine {
  const lang = (def.params?.language as string | undefined) || DEFAULT_WEBSpeech_STT_LANG
  let recognition: SpeechRecognitionLike | null = null

  return {
    type: "webspeech",
    isAvailable: () => Boolean(recognitionCtor()),
    start(options: { onResult: (text: string) => void; onError?: (err: string) => void; onEnd?: () => void }) {
      const Ctor = recognitionCtor()
      if (!Ctor) { options.onError?.("unsupported"); return }
      recognition?.abort()
      const rec = new Ctor()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = lang
      rec.onresult = (e) => {
        let text = ""
        for (let i = 0; i < e.results.length; i++) {
          if (e.results[i].isFinal) text += e.results[i][0].transcript
        }
        if (text) options.onResult(text)
      }
      rec.onerror = (e) => options.onError?.(e.error)
      rec.onend = () => options.onEnd?.()
      recognition = rec
      rec.start()
    },
    stop() {
      try { recognition?.stop() } catch { /* ignore */ }
      recognition = null
    },
  }
}