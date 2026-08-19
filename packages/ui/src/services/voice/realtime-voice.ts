/**
 * 实时语音对话 — 薄封装 core 统一编排 VoiceSessionManager
 *
 * 引擎（VAD/STT/TTS）由目录解析（voice.json 插件化），
 * 编排（检话/采集/转写/打断/turn 世代）下沉 core；本层只做：
 *   - core 事件 → onStatusChange 回调
 *   - options 注入（TTS / 转写 / Agent 回调）
 *
 * 零 React 依赖，可复用于主聊天窗口与桌宠。API 与旧版保持一致：
 * start / speak / stop。
 */

import { VoiceSessionManager } from "@mira/core/voice"
import type { VADOptions, VADController } from "@mira/core/voice"
import type { TTSEngine } from "./types"
import { getVADEngine } from "./engine-registry"

export type RealtimeStatus = "idle" | "listening" | "processing" | "speaking"

export interface RealtimeVoiceOptions {
  /** TTS 引擎（播放 Agent 回复） */
  tts: TTSEngine
  /** 语音识别（本地 Whisper 封装） */
  transcribe: (audio: Float32Array) => Promise<string>
  /** 用户一段语音识别完成后回调（转发给 Agent） */
  onUserSpeech: (text: string) => void
  /** 对话状态变化（UI 展示） */
  onStatusChange?: (status: RealtimeStatus) => void
  /** 可选注入 VAD 工厂（默认从目录解析默认选中项） */
  vadFactory?: (options: VADOptions) => VADController
}

export class RealtimeVoice {
  private session: VoiceSessionManager | null = null
  private status: RealtimeStatus = "idle"

  constructor(private options: RealtimeVoiceOptions) {}

  /** 懒构建编排会话：首次 start/speak 前解析 VAD 引擎（目录驱动） */
  private async ensureSession(): Promise<VoiceSessionManager> {
    if (this.session) return this.session
    const vadFactory: (options: VADOptions) => VADController = this.options.vadFactory ?? (await getVADEngine())
    const session = new VoiceSessionManager({
      engines: {
        tts: this.options.tts,
        transcribe: this.options.transcribe,
        vad: vadFactory,
      },
      onUserSpeech: this.options.onUserSpeech,
    })

    session.on("state_change", (e) => {
      const state = (e as { data?: { state?: string } }).data?.state
      const status: RealtimeStatus = state === "interrupted" ? "speaking" : ((state as RealtimeStatus) ?? "idle")
      this.status = status
      this.options.onStatusChange?.(status)
    })
    this.session = session
    return session
  }

  /** 启动：开启麦克风 + VAD 循环，进入连续监听 */
  async start(): Promise<void> {
    const s = await this.ensureSession()
    await s.start()
  }

  /** 播放 Agent 回复（TTS），播放期间暂停 VAD 采集避免回声误判 */
  async speak(text: string): Promise<void> {
    const s = await this.ensureSession()
    await s.speak(text)
  }

  stop(): void {
    this.session?.stop()
  }

  /** 当前状态（供 UI 同步展示） */
  getStatus(): RealtimeStatus {
    return this.status
  }
}