/**
 * 语音活动检测 (VAD)
 * 检测用户是否在说话，支持自然打断
 */

import { EventEmitter } from 'events'
import type { VADConfig, VADEvent, VADEventType, VADState } from './types'

/** 默认 VAD 配置 */
const DEFAULT_VAD_CONFIG: VADConfig = {
  threshold: 0.3,
  debounceMs: 100,
  minSpeechMs: 200,
  minSilenceMs: 500,
  sampleRate: 16000,
}

/**
 * 语音活动检测器
 */
export class VoiceActivityDetector extends EventEmitter {
  private config: VADConfig
  private state: VADState = 'idle'
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private stream: MediaStream | null = null
  private animationFrame: number | null = null
  
  private lastSpeechTime = 0
  private lastSilenceTime = 0
  private isSpeaking = false
  private energyHistory: number[] = []
  private readonly ENERGY_HISTORY_SIZE = 10

  constructor(config?: Partial<VADConfig>) {
    super()
    this.config = { ...DEFAULT_VAD_CONFIG, ...config }
  }

  /**
   * 开始检测
   */
  async start(mediaStream: MediaStream): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error('VAD 已在运行')
    }

    this.stream = mediaStream
    
    // 创建音频上下文
    this.audioContext = new AudioContext({
      sampleRate: this.config.sampleRate,
    })

    // 创建分析器
    this.analyser = this.audioContext.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.8

    // 连接音频源
    this.source = this.audioContext.createMediaStreamSource(mediaStream)
    this.source.connect(this.analyser)

    this.setState('listening')
    this.startDetection()

    this.emitVADEvent('speech_start')
  }

  /**
   * 停止检测
   */
  stop(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = null
    }

    if (this.source) {
      this.source.disconnect()
      this.source = null
    }

    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }

    this.analyser = null
    this.stream = null
    this.setState('idle')
  }

  /**
   * 开始检测循环
   */
  private startDetection(): void {
    const detect = () => {
      if (!this.analyser || this.state === 'idle') return

      const energy = this.calculateEnergy()
      this.energyHistory.push(energy)
      
      if (this.energyHistory.length > this.ENERGY_HISTORY_SIZE) {
        this.energyHistory.shift()
      }

      const now = Date.now()
      const avgEnergy = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length

      if (avgEnergy > this.config.threshold) {
        // 检测到语音
        if (!this.isSpeaking) {
          if (now - this.lastSilenceTime >= this.config.minSilenceMs) {
            this.isSpeaking = true
            this.lastSpeechTime = now
            this.setState('speaking')
            this.emitVADEvent('speech_start')
          }
        }
        this.lastSilenceTime = now
      } else {
        // 检测到静音
        if (this.isSpeaking) {
          if (now - this.lastSpeechTime >= this.config.minSpeechMs) {
            this.isSpeaking = false
            this.lastSilenceTime = now
            this.setState('listening')
            this.emitVADEvent('speech_end')
          }
        }
      }

      this.animationFrame = requestAnimationFrame(detect)
    }

    this.animationFrame = requestAnimationFrame(detect)
  }

  /**
   * 计算音频能量
   */
  private calculateEnergy(): number {
    if (!this.analyser) return 0

    const bufferLength = this.analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)
    this.analyser.getByteTimeDomainData(dataArray)

    let sum = 0
    for (let i = 0; i < bufferLength; i++) {
      const value = (dataArray[i] - 128) / 128
      sum += value * value
    }

    return Math.sqrt(sum / bufferLength)
  }

  /**
   * 设置状态
   */
  private setState(state: VADState): void {
    if (this.state === state) return
    this.state = state
    this.emit('stateChange', state)
  }

  /**
   * 发送 VAD 事件
   */
  private emitVADEvent(type: VADEventType): void {
    const event: VADEvent = {
      type,
      timestamp: Date.now(),
      energy: this.energyHistory[this.energyHistory.length - 1],
    }
    this.emit('vad', event)
  }

  /**
   * 获取当前状态
   */
  getState(): VADState {
    return this.state
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<VADConfig>): void {
    this.config = { ...this.config, ...config }
  }
}
