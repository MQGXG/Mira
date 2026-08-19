/**
 * 能量 VAD 引擎 — Web Audio 能量检测（无模型依赖，纯音频层）
 *
 * 从 UI `vad.ts` 下沉 core，默认阈值参数化（def.params）。
 * 不依赖 DOM 实例，process() 每帧喂入音量即可，可单测。
 */

import type { VADController, VADOptions, VoiceEngineDef } from "../types"

/** 默认参数（无 def.params 覆盖时使用） */
export const DEFAULT_ENERGY_VAD_PARAMS = {
  speechThreshold: 0.02,
  silenceThreshold: 0.008,
  silenceDurationMs: 900,
  speechDurationMs: 200,
}

/** 创建一个能量 VAD 引擎；返回构造器，可注入运行时 options（缺省取 def.params） */
export function createEnergyVADEngine(def: VoiceEngineDef) {
  const p = { ...DEFAULT_ENERGY_VAD_PARAMS, ...(def.params as Partial<typeof DEFAULT_ENERGY_VAD_PARAMS> | undefined) }

  return (options: VADOptions): VADController => {
    const speechThreshold = options.speechThreshold ?? p.speechThreshold
    const silenceThreshold = options.silenceThreshold ?? p.silenceThreshold
    const silenceDurationMs = options.silenceDurationMs ?? p.silenceDurationMs
    const speechDurationMs = options.speechDurationMs ?? p.speechDurationMs

    let speaking = false
    let voicedMs = 0
    let silentMs = 0
    let lastTime = 0
    let speechStart: number | undefined
    let speechEnd: number | undefined

    function process(volume: number): void {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now()
      const dt = lastTime === 0 ? 16 : now - lastTime
      lastTime = now

      if (!speaking) {
        if (volume >= speechThreshold) {
          voicedMs += dt
          silentMs = 0
          if (voicedMs >= speechDurationMs) {
            speaking = true
            voicedMs = 0
            speechStart = now
            speechEnd = undefined
            options.onStateChange({ speaking: true, speechStart })
          }
        } else {
          voicedMs = 0
        }
      } else {
        if (volume < silenceThreshold) {
          silentMs += dt
          if (silentMs >= silenceDurationMs) {
            speaking = false
            silentMs = 0
            speechEnd = now
            options.onStateChange({ speaking: false, speechStart, speechEnd })
          }
        } else {
          silentMs = 0
        }
      }
    }

    function reset(): void {
      speaking = false
      voicedMs = 0
      silentMs = 0
      lastTime = 0
      speechStart = undefined
      speechEnd = undefined
    }

    return { process, reset }
  }
}