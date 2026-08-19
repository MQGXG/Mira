/**
 * 语音会话管理器 — 统一编排（引擎注入式，一切皆插件）
 *
 * 组合 voice 模块各引擎实现连续对话：麦克风 → VAD 检话 → 语音段采集 →
 * STT 转写 → onUserSpeech 回调（转发给 Agent）→ TTS 播放回复；播放中
 * 检测到说话自动打断（turn 世代防旧回合迟到事件串话）。
 *
 * 引擎来源（优先级）：config.engines 注入 > VoiceRegistry（engineIds 或
 * voice.json 默认选中项）。渲染进程使用（麦克风 / rAF / AudioContext）。
 */

import { LightEmitter } from "./emitter"
import { VoiceRegistry } from "./registry"
import {
  startMicRecording,
  recordChunk,
  mergeChunks,
  getCurrentVolume,
} from "./audio-utils"
import type {
  VoiceSessionConfig,
  VoiceSessionState,
  VoiceSessionEvent,
  VoiceSessionEventType,
  STTResult,
  STTEngine,
  TTSEngine,
  VADController,
  VADOptions,
} from "./types"

/** 默认会话配置（引擎参数实际来自 voice.json/engineIds，此处保留占位） */
const DEFAULT_SESSION_CONFIG: VoiceSessionConfig = {
  enableInterruption: true,
  enableAutoVAD: true,
  vad: {
    threshold: 0.3,
    debounceMs: 100,
    minSpeechMs: 200,
    minSilenceMs: 500,
  },
  stt: {
    model: 'whisper-base',
    language: 'zh-CN',
    continuous: true,
  },
  tts: {
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    streaming: true,
  },
}

/**
 * 语音会话管理器
 */
export class VoiceSessionManager extends LightEmitter {
  private config: VoiceSessionConfig
  private state: VoiceSessionState = 'idle'

  // 引擎（config.engines 注入优先于 VoiceRegistry）
  private sttEngine: STTEngine | undefined
  private ttsEngine: TTSEngine | undefined
  private vadFactory: ((options: VADOptions) => VADController) | undefined

  // 运行时资源
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private recorder: { stop: () => void } | null = null
  private vadController: VADController | null = null
  private vadStop: (() => void) | null = null
  private currentChunk: Float32Array[] = []
  private collecting = false
  private busy = false
  private speaking = false
  private transcriptBuffer: string = ''
  private lastTranscriptTime = 0
  /** turn 世代：每次用户语音开始 +1，防止旧回合的迟到音频/文本串话 */
  private turnGeneration = 0

  constructor(config?: Partial<VoiceSessionConfig>) {
    super()
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config }
    this.resolveEngines()
  }

  /** 解析引擎：config.engines 注入 > VoiceRegistry（engineIds / 默认选中项） */
  private resolveEngines(): void {
    const injected = this.config.engines
    this.sttEngine = injected?.stt ?? VoiceRegistry.getSTTEngine(this.config.engineIds?.stt)
    this.ttsEngine = injected?.tts ?? VoiceRegistry.getTTSEngine(this.config.engineIds?.tts)
    this.vadFactory = injected?.vad ?? VoiceRegistry.getVADEngine(this.config.engineIds?.vad)
  }

  /**
   * 开始语音会话
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error('语音会话已在运行')
    }
    if (!this.vadFactory) {
      throw new Error('无可用 VAD 引擎')
    }

    try {
      const mic = await startMicRecording()
      this.ctx = mic.ctx
      this.analyser = mic.analyser
      this.stream = mic.stream

      // 持续采集 16k 音频；仅在 collecting（说话中）且未在播放时写入当前段
      this.recorder = recordChunk(mic.ctx, mic.stream, 16000, (c) => {
        if (this.collecting && !this.speaking) this.currentChunk.push(c)
      })

      // VAD 状态 → 收集边界 / 打断
      this.vadController = this.vadFactory({
        onStateChange: (r) => {
          if (r.speaking) {
            if (this.speaking && this.config.enableInterruption) {
              // 播放中被说话 → 打断当前回复
              this.ttsEngine?.stop()
              this.setState('interrupted')
              return
            }
            if (!this.busy && !this.collecting) {
              this.turnGeneration++
              this.collecting = true
              this.currentChunk = []
              this.setState('listening')
            }
          } else if (this.collecting) {
            this.collecting = false
            this.flush()
          }
        },
      })

      this.vadStop = this.startVADLoop()
      this.setState('listening')
      this.emitEvent('ready')
    } catch (error) {
      this.emitEvent('error', error)
      throw error
    }
  }

  /** rAF 驱动 VAD 能量检测；非渲染进程环境返回空停止函数 */
  private startVADLoop(): () => void {
    if (!this.analyser || !this.vadController || typeof requestAnimationFrame === 'undefined') {
      return () => { /* 非渲染环境：VAD 由外部驱动 */ }
    }
    let raf = 0
    const loop = () => {
      if (this.vadController && this.analyser) {
        this.vadController.process(getCurrentVolume(this.analyser))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }

  /**
   * 停止语音会话
   */
  stop(): void {
    this.vadStop?.()
    this.vadStop = null
    this.recorder?.stop()
    this.recorder = null
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.ctx = null
    this.analyser = null
    this.ttsEngine?.stop()
    this.vadController?.reset()
    this.vadController = null

    this.transcriptBuffer = ''
    this.currentChunk = []
    this.collecting = false
    this.busy = false
    this.speaking = false
    this.setState('idle')
  }

  /** 一段语音结束：拼接音频 → STT 转写 → 回调 onUserSpeech */
  private flush(): void {
    if (this.currentChunk.length === 0) return
    const audio = mergeChunks(this.currentChunk, 16000)
    this.currentChunk = []
    if (audio.length < 1600) return // <0.1s 视为无效

    this.busy = true
    this.setState('processing')
    this.transcribe(audio)
      .then((text) => {
        this.busy = false
        if (text.trim()) {
          this.emitEvent('transcript', { text: text.trim(), isFinal: true, confidence: 1 })
          this.config.onUserSpeech?.(text.trim())
        }
        this.setState('idle')
      })
      .catch((err) => {
        this.busy = false
        this.emitEvent('error', err)
        this.setState('idle')
      })
  }

  /** 转写：config.engines.transcribe 注入 > STT 引擎 transcribe 方法 */
  private async transcribe(audio: Float32Array): Promise<string> {
    const injected = this.config.engines?.transcribe
    if (injected) return injected(audio)
    if (this.sttEngine && typeof this.sttEngine.transcribe === 'function') {
      return this.sttEngine.transcribe(audio)
    }
    throw new Error('无可用 STT 转写引擎')
  }

  /** 播放 Agent 回复（TTS），播放期间保持 speaking 状态 */
  async speak(text: string): Promise<void> {
    if (!text.trim()) return
    if (!this.ttsEngine) throw new Error('无可用 TTS 引擎')
    this.speaking = true
    this.setState('speaking')
    try {
      await this.ttsEngine.speak(text, {
        onStart: () => this.setState('speaking'),
        onEnd: () => {
          this.speaking = false
          this.setState('idle')
        },
      })
    } finally {
      if (this.speaking) {
        this.speaking = false
        if (this.state === 'speaking' || this.state === 'interrupted') {
          this.setState('idle')
        }
      }
    }
  }

  /**
   * 处理语音开始（旧 API 保留：递增世代并进入处理态，供外部/测试模拟 VAD）
   */
  handleSpeechStart(): void {
    this.turnGeneration++
    this.setState('processing')
  }

  /**
   * 处理语音结束（旧 API 保留：收集边界由 VAD 状态机驱动，此处仅清理状态）
   */
  handleSpeechEnd(): void {
    this.collecting = false
    this.setState('listening')
  }

  /**
   * 处理 STT 结果（旧 API 保留：外部 STT 引擎上报）
   */
  handleSTTResult(result: STTResult): void {
    if (result.isFinal) {
      this.transcriptBuffer = result.text
      this.lastTranscriptTime = Date.now()
    }
    this.emitEvent('transcript', result)
  }

  /**
   * 设置状态
   */
  private setState(state: VoiceSessionState): void {
    if (this.state === state) return
    const previousState = this.state
    this.state = state
    this.emitEvent('state_change', { state, previousState })
  }

  /**
   * 发送事件
   */
  private emitEvent(type: VoiceSessionEventType, data?: unknown): void {
    const event: VoiceSessionEvent = {
      type,
      data,
      generation: this.turnGeneration,
    }
    this.emit(type, event)
  }

  /** 当前世代号（新回合 +1） */
  getGeneration(): number {
    return this.turnGeneration
  }

  /** 事件是否属于当前世代（防旧回合迟到响应） */
  isCurrentGeneration(generation?: number): boolean {
    return generation === undefined || generation >= this.turnGeneration
  }

  /**
   * 获取当前状态
   */
  getState(): VoiceSessionState {
    return this.state
  }

  /**
   * 获取配置
   */
  getConfig(): VoiceSessionConfig {
    return { ...this.config }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<VoiceSessionConfig>): void {
    this.config = { ...this.config, ...config }
    this.resolveEngines()
  }
}