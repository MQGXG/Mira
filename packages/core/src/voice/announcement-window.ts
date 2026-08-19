/**
 * 插话安全窗口 — 后台播报只在“安全窗口”内开口
 *
 * 参考 qwen-audio-agent `server/src/voice/announcement/announcement-window.mjs`：
 * 当 用户正在说话 / 本回合尚未结束 / 还有排队音频 时，后台结果不得插播，
 * 避免覆盖当前对话。播放以真实 playback 为准（startPlayback/finishPlayback）。
 *
 * 纯 TS 零依赖，可单测。
 */

export type SpeechOrigin = "model" | "announcement"

export interface ResponseInfo {
  turnId?: string
  origin?: SpeechOrigin
  hasAudio?: boolean
  hasFunctionCall?: boolean
  suppressed?: boolean
  failed?: boolean
}

export class AnnouncementWindow {
  private userSpeaking = false
  private activeTurnId = ""
  private turnPending = false
  private audioResponses = new Map<string, { turnId: string; origin: SpeechOrigin }>()
  private playingResponses = new Set<string>()

  /** 用户回合开始（eg. VAD 检测到用户说话） */
  beginTurn(turnId: string | number): void {
    this.userSpeaking = true
    this.activeTurnId = String(turnId ?? "")
    this.turnPending = true
  }

  /** 用户语音结束 */
  endSpeech(): void {
    this.userSpeaking = false
  }

  /** 模型响应结束。若为公告或非当前回合/含音频/含函数调用则保持 pending */
  responseDone(info: ResponseInfo = {}): void {
    const turnId = String(info.turnId ?? "")
    if (info.origin === "announcement") return
    if (turnId && turnId !== this.activeTurnId) return
    if (info.hasAudio) return
    if (info.hasFunctionCall && !info.suppressed && !info.failed) return
    this.turnPending = false
  }

  /** 登记一段待播音频所属的 turn */
  queueAudio(responseId: string, context: ResponseInfo = {}): void {
    const id = String(responseId ?? "")
    if (!id) return
    this.audioResponses.set(id, {
      turnId: String(context.turnId ?? ""),
      origin: context.origin ?? "model",
    })
  }

  /** 播报起点：真实播放已开始（作为送达确认） */
  startPlayback(responseId: string): void {
    const id = String(responseId ?? "")
    if (id) this.playingResponses.add(id)
  }

  /** 播放结束：若为当前 model 回合且无后续调用，视为回合完成 */
  finishPlayback(responseId: string, info: ResponseInfo = {}): void {
    const id = String(responseId ?? "")
    const context = this.audioResponses.get(id)
    this.audioResponses.delete(id)
    this.playingResponses.delete(id)
    if (context && context.origin !== "announcement" && context.turnId && context.turnId === this.activeTurnId && !info.hasFunctionCall) {
      this.turnPending = false
    }
  }

  /** 用户打断：清除非公告 pending */
  interrupt(): void {
    this.turnPending = false
  }

  /** 重置全部状态 */
  reset(): void {
    this.userSpeaking = false
    this.activeTurnId = ""
    this.turnPending = false
    this.audioResponses.clear()
    this.playingResponses.clear()
  }

  /** 是否处于安全窗口之外（此时不该开口播报） */
  isBlocked(): boolean {
    return this.userSpeaking || this.turnPending || this.audioResponses.size > 0
  }

  /** 是否正在播放音频 */
  isPlaying(): boolean {
    return this.playingResponses.size > 0
  }
}