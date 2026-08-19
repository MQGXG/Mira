/**
 * 打断机制
 * 支持用户说话时自动暂停 Agent 输出
 */

import { EventEmitter } from 'events'
import type { InterruptionConfig, InterruptionEvent } from './types'

/** 默认打断配置 */
const DEFAULT_INTERRUPTION_CONFIG: InterruptionConfig = {
  sensitivity: 0.5,
  cooldownMs: 500,
  autoResume: true,
}

/**
 * 打断管理器
 */
export class InterruptionManager extends EventEmitter {
  private config: InterruptionConfig
  private isPlaying = false
  private isInterrupted = false
  private audioQueue: ArrayBuffer[] = []
  private onInterruptCallback: (() => void) | null = null
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null
  private audioElement: HTMLAudioElement | null = null

  constructor(config?: Partial<InterruptionConfig>) {
    super()
    this.config = { ...DEFAULT_INTERRUPTION_CONFIG, ...config }
  }

  /**
   * 设置音频元素
   */
  setAudioElement(element: HTMLAudioElement): void {
    this.audioElement = element
    
    // 监听播放事件
    element.addEventListener('play', () => {
      this.isPlaying = true
      this.emitEvent('interrupt_end')
    })

    element.addEventListener('ended', () => {
      this.isPlaying = false
      this.audioQueue.shift()
      this.playNext()
    })

    element.addEventListener('error', () => {
      this.isPlaying = false
      this.emitEvent('interrupt_cancel')
    })
  }

  /**
   * 播放音频 (支持打断)
   */
  async playWithInterruption(audio: ArrayBuffer): Promise<void> {
    if (this.isInterrupted) {
      this.audioQueue.push(audio)
      return
    }

    this.audioQueue.push(audio)
    
    if (!this.isPlaying) {
      this.playNext()
    }
  }

  /**
   * 播放下一个音频
   */
  private playNext(): void {
    if (this.audioQueue.length === 0 || !this.audioElement) return

    const audio = this.audioQueue[0]
    const blob = new Blob([audio], { type: 'audio/wav' })
    const url = URL.createObjectURL(blob)

    this.audioElement.src = url
    this.audioElement.play().catch(() => {
      // 播放失败，移除并尝试下一个
      this.audioQueue.shift()
      this.playNext()
    })
  }

  /**
   * 立即打断
   */
  interrupt(reason?: string): void {
    if (!this.isPlaying) return

    this.isInterrupted = true
    this.audioQueue = []

    if (this.audioElement) {
      this.audioElement.pause()
      this.audioElement.currentTime = 0
    }

    this.isPlaying = false
    this.emitEvent('interrupt_start', reason)

    // 启动冷却计时器
    this.startCooldown()
  }

  /**
   * 取消打断
   */
  cancelInterrupt(): void {
    if (!this.isInterrupted) return

    this.isInterrupted = false
    this.emitEvent('interrupt_cancel')
  }

  /**
   * 启动冷却计时器
   */
  private startCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
    }

    this.cooldownTimer = setTimeout(() => {
      this.isInterrupted = false
      this.emitEvent('interrupt_end')
      
      // 如果有队列且允许自动恢复，继续播放
      if (this.config.autoResume && this.audioQueue.length > 0) {
        this.playNext()
      }
    }, this.config.cooldownMs)
  }

  /**
   * 设置打断回调
   */
  onUserSpeaking(callback: () => void): void {
    this.onInterruptCallback = callback
  }

  /**
   * 检测到用户说话时调用
   */
  handleUserSpeaking(): void {
    if (this.isPlaying && !this.isInterrupted) {
      this.interrupt('user_speaking')
      this.onInterruptCallback?.()
    }
  }

  /**
   * 发送打断事件
   */
  private emitEvent(type: InterruptionEvent['type'], reason?: string): void {
    const event: InterruptionEvent = {
      type,
      timestamp: Date.now(),
      reason,
    }
    this.emit('interruption', event)
  }

  /**
   * 获取状态
   */
  getState(): {
    isPlaying: boolean
    isInterrupted: boolean
    queueLength: number
  } {
    return {
      isPlaying: this.isPlaying,
      isInterrupted: this.isInterrupted,
      queueLength: this.audioQueue.length,
    }
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    this.audioQueue = []
  }

  /**
   * 销毁
   */
  destroy(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer)
    }
    this.audioQueue = []
    this.isPlaying = false
    this.isInterrupted = false
  }
}
