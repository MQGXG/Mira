/**
 * Whisper STT 引擎 — transformers.js 本地推理（离线、数据不出本机）
 *
 * 从 UI `stt.ts` 下沉 core，模型 id 参数化（def.model）。
 * 双模式：
 *  - start/stop 录音式（"按住说话"，VoiceInput 听写场景）
 *  - transcribe(audio) 函数式（统一编排 VoiceSession 场景，音频已由会话采集）
 */

import type { STTEngine, VoiceEngineDef } from "../types"
import { recordChunk, mergeChunks } from "../audio-utils"
import { loadASRPipeline } from "../transformers-loader"

export const DEFAULT_WHISPER_MODEL = "onnx-community/whisper-base"

type Transcriber = (audio: Float32Array) => Promise<string>

/** 创建一个 Whisper 本地 STT 引擎实例 */
export function createWhisperSTTEngine(def: VoiceEngineDef): STTEngine {
  const model = def.model || DEFAULT_WHISPER_MODEL
  let ctx: AudioContext | null = null
  let stream: MediaStream | null = null
  let recorder: { stop: () => void } | null = null
  let chunks: Float32Array[] = []
  let resolving = false
  let onResultCb: ((text: string) => void) | null = null
  let onErrorCb: ((err: string) => void) | null = null

  let transcriberPromise: Promise<Transcriber> | null = null

  /** 惰性加载 pipeline 并缓存转写函数（start/transcribe 共用） */
  function getTranscriber(): Promise<Transcriber> {
    if (!transcriberPromise) {
      transcriberPromise = loadASRPipeline(model).then((p) => async (a: Float32Array) => {
        const out = await p(a, { return_timestamps: false })
        const first = Array.isArray(out) ? out[0] : out
        return first?.text ?? ""
      })
    }
    return transcriberPromise
  }

  /** 函数式转写（stop 与 transcribe 共用） */
  async function transcribeAudio(audio: Float32Array): Promise<string> {
    const fn = await getTranscriber()
    return fn(audio)
  }

  return {
    type: "local",
    isAvailable: () => typeof navigator !== "undefined" && !!navigator.mediaDevices,
    start(options: { onResult: (text: string) => void; onError?: (err: string) => void; onEnd?: () => void }) {
      onResultCb = options.onResult
      onErrorCb = options.onError || null

      // 预加载 Whisper 模型（可选：让首次识别的等待发生在录音期间）
      getTranscriber().catch(() => { /* 静默：失败时在识别阶段报错 */ })

      navigator.mediaDevices.getUserMedia({ audio: true }).then((ms) => {
        if (resolving) { ms.getTracks().forEach((t) => t.stop()); return }
        stream = ms
        if (!ctx) ctx = new AudioContext()
        chunks = []
        recorder = recordChunk(ctx, ms, 16000, (c) => { if (!resolving) chunks.push(c) })
      }).catch((err: unknown) => {
        onErrorCb?.(err instanceof Error ? err.message : String(err))
      })
    },
    async stop() {
      if (resolving) return
      resolving = true
      recorder?.stop()
      stream?.getTracks().forEach((t) => t.stop())
      recorder = null
      stream = null

      try {
        const audio = mergeChunks(chunks, 16000)
        if (audio.length < 1600) { resolving = false; return }
        const text = await transcribeAudio(audio)
        if (text) onResultCb?.(text)
      } catch (err) {
        onErrorCb?.(err instanceof Error ? err.message : String(err))
      } finally {
        resolving = false
        onResultCb = null
        onErrorCb = null
      }
    },
    transcribe: transcribeAudio,
  }
}