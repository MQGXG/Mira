/**
 * 语音模块共享类型 — 引擎接口收敛自 core（@mira/core/voice）
 *
 * UI 只依赖 core 定义的类型（依赖反转 + 单一数据源），不再本地重复定义引擎接口。
 */

export type {
  STTType,
  TTSType,
  STTEngine,
  TTSEngine,
  VADResult,
} from "@mira/core/voice"

/** 实时语音对话编排的回调上下文 */
export interface RealtimeVoiceHooks {
  /** 用户说话识别完成后回调（转 Agent） */
  onUserSpeech: (text: string) => void
  /** Agent 回复文本回调（用于 TTS + 口型） */
  onAssistantSpeech: (text: string) => void
  /** 对话状态变化 */
  onStatusChange: (status: "idle" | "listening" | "processing" | "speaking") => void
}
