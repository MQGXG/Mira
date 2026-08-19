/**
 * Kokoro TTS 引擎 — transformers.js 本地推理（离线、数据不出本机）
 *
 * 从 UI `tts.ts` 下沉 core，模型 id 参数化（def.model）。
 * 运行时合成失败自动回退 WebSpeech 引擎。
 */

import type { TTSEngine, VoiceEngineDef } from "../types"
import { playFloat32 } from "../audio-utils"
import { loadTTSPipeline } from "../transformers-loader"
import { createWebSpeechTTSEngine } from "./tts-webspeech"

export const DEFAULT_KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX"

/** transformers.js 的 pipeline 动态导入类型（避免顶层 import 拖慢启动） */
type LocalTTS = {
  textToSpeech: (text: string, options?: { speaker_id?: number }) => Promise<{ audio: Float32Array; sampling_rate: number }>
}

/** 创建一个 Kokoro 本地 TTS 引擎实例 */
export function createKokoroTTSEngine(def: VoiceEngineDef): TTSEngine {
  const model = def.model || DEFAULT_KOKORO_MODEL
  const speakerId = def.params?.speaker_id as number | undefined
  let ctx: AudioContext | null = null
  let pipelinePromise: Promise<LocalTTS> | null = null
  let activeSource: AudioBufferSourceNode | null = null

  function ensureAudioContext(): AudioContext {
    if (!ctx) ctx = new AudioContext()
    return ctx
  }

  async function loadPipeline(): Promise<LocalTTS> {
    if (!pipelinePromise) {
      pipelinePromise = loadTTSPipeline(model).then((p) => ({
        textToSpeech: async (t: string, o?: { speaker_id?: number }) => {
          const out = await p(t, { speaker_id: o?.speaker_id ?? speakerId })
          if (!out) throw new Error("TTS 返回空")
          return { audio: out.audio, sampling_rate: out.sampling_rate }
        },
      }))
    }
    return pipelinePromise
  }

  return {
    type: "local",
    isAvailable: () => typeof window !== "undefined" && "AudioContext" in window,
    async speak(text, options) {
      if (!text.trim()) return
      let started = false
      try {
        const tts = await loadPipeline()
        const out = await tts.textToSpeech(text)
        const ac = ensureAudioContext()
        const { node, promise } = playFloat32(ac, out.audio, out.sampling_rate)
        activeSource = node
        started = true
        options?.onStart?.()
        await promise
        options?.onEnd?.()
      } catch (err) {
        console.warn("[voice] 本地 TTS 失败，回退 WebSpeech:", err)
        // 回退规则：
        //  - started=false：尚未开始播放（模型加载/合成失败），整段交给 WebSpeech（含 onStart）
        //  - started=true ：播放中途异常，只补 onEnd，不再重复 onStart
        if (started) {
          options?.onEnd?.()
          return
        }
        const fallback = createWebSpeechTTSEngine(def)
        await fallback.speak(text, options)
      }
    },
    stop() {
      activeSource?.stop()
      activeSource = null
    },
  }
}