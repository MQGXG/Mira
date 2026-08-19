/**
 * 语音交互类型定义
 * 参考 Qwen Audio Agent 的全双工语音交互设计
 */

// ============================================================================
// 引擎接口（可插拔 — 注册表驱动，一切皆插件）
// 引擎定义在 voice-catalog.ts 注册，实现工厂按 kind 分派。
// ============================================================================

export type STTType = "local" | "webspeech" | "custom"

export type TTSType = "webspeech" | "local" | "custom"

export type VoiceEngineKind = "stt" | "tts" | "vad"

/** 内置实现名（可被用户 voice.json / 插件扩展） */
export type VoiceEngineImplementation =
  | "whisper"
  | "webspeech-stt"
  | "kokoro"
  | "webspeech-tts"
  | "energy-vad"

/** 引擎目录条目（三层合并：内置 JSON < 用户 voice.json < 插件 registerVoice） */
export interface VoiceEngineDef {
  /** 全局唯一 id（如 whisper-base / webspeech-stt / kokoro） */
  id: string
  kind: VoiceEngineKind
  label: string
  /** 映射到已注册的实现工厂 */
  implementation: VoiceEngineImplementation | string
  /** 模型仓库 id（本地推理引擎，如 Whisper/Kokoro ONNX） */
  model?: string
  /** 实现参数（阈值、dtype、language 等） */
  params?: Record<string, unknown>
}

/** STT 引擎接口 */
export interface STTEngine {
  readonly type: STTType
  /** 是否可用（如本地模型未加载/浏览器不支持 Web Speech） */
  isAvailable(): boolean
  /** 开始监听；onResult 在识别出结果时回调（可多次） */
  start(options: { onResult: (text: string) => void; onError?: (err: string) => void; onEnd?: () => void }): void
  stop(): void
  /** 函数式转写一段已采集音频（供统一编排 VoiceSession 使用；录音式引擎可省略） */
  transcribe?(audio: Float32Array): Promise<string>
}

/** TTS 引擎接口 */
export interface TTSEngine {
  readonly type: TTSType
  isAvailable(): boolean
  /** 朗读文本；返回 Promise 在朗读完成/停止时 resolve */
  speak(text: string, options?: { onStart?: () => void; onEnd?: () => void }): Promise<void>
  stop(): void
}

/** VAD 检测结果 */
export interface VADResult {
  /** 当前是否有语音 */
  speaking: boolean
  /** 语音活动开始时间（ms） */
  speechStart?: number
  /** 语音活动结束时间（ms） */
  speechEnd?: number
}

/** VAD 引擎参数（缺省值取引擎 def.params） */
export interface VADOptions {
  speechThreshold?: number
  silenceThreshold?: number
  silenceDurationMs?: number
  speechDurationMs?: number
  onStateChange: (result: VADResult) => void
}

/** VAD 控制器 */
export interface VADController {
  /** 处理一帧音量（每帧调用，通常在 rAF 循环里） */
  process(volume: number): void
  reset(): void
}

/** 引擎工厂签名（实现层注册到 VoiceRegistry） */
export type STTEngineFactory = (def: VoiceEngineDef) => STTEngine
export type TTSEngineFactory = (def: VoiceEngineDef) => TTSEngine
/** VAD 工厂：先按 def 得到默认参数，返回可注入运行时 options 的构造器 */
export type VADEngineFactory = (def: VoiceEngineDef) => (options: VADOptions) => VADController

// ============================================================================
// VAD (Voice Activity Detection) 语音活动检测
// ============================================================================

/** VAD 配置 */
export interface VADConfig {
  /** 语音活动阈值 (0-1) */
  threshold: number
  /** 防抖时间 (ms) */
  debounceMs: number
  /** 最小语音时长 (ms) */
  minSpeechMs: number
  /** 最小静音时长 (ms) */
  minSilenceMs: number
  /** 音频采样率 */
  sampleRate?: number
}

/** VAD 事件类型 */
export type VADEventType = 'speech_start' | 'speech_end' | 'silence_start' | 'silence_end'

/** VAD 事件 */
export interface VADEvent {
  type: VADEventType
  timestamp: number
  energy?: number
}

/** VAD 状态 */
export type VADState = 'idle' | 'listening' | 'speaking' | 'silence'

// ============================================================================
// STT (Speech-to-Text) 语音转文字
// ============================================================================

/** STT 配置 */
export interface STTConfig {
  /** 模型类型 */
  model: 'whisper-tiny' | 'whisper-base' | 'whisper-small' | 'whisper-medium' | 'whisper-large'
  /** 语言 */
  language?: string
  /** 是否连续模式 */
  continuous?: boolean
  /** 最大音频长度 (ms) */
  maxAudioLength?: number
}

/** STT 结果 */
export interface STTResult {
  /** 转录文本 */
  text: string
  /** 是否是最终结果 */
  isFinal: boolean
  /** 置信度 (0-1) */
  confidence: number
  /** 语言检测 */
  language?: string
  /** 处理耗时 (ms) */
  durationMs?: number
}

/** STT 事件类型 */
export type STTEventType = 'partial' | 'final' | 'error' | 'vad_event'

/** STT 事件 */
export interface STTEvent {
  type: STTEventType
  result?: STTResult
  error?: string
  vadEvent?: VADEvent
}

// ============================================================================
// TTS (Text-to-Speech) 文字转语音
// ============================================================================

/** TTS 配置 */
export interface TTSConfig {
  /** 语音类型 */
  voice?: string
  /** 语速 (0.5-2.0) */
  rate?: number
  /** 音调 (0.5-2.0) */
  pitch?: number
  /** 音量 (0-1) */
  volume?: number
  /** 语言 */
  language?: string
  /** 是否流式 */
  streaming?: boolean
}

/** TTS 结果 */
export interface TTSResult {
  /** 音频数据 (base64) */
  audio: string
  /** 音频格式 */
  format: 'wav' | 'mp3' | 'ogg'
  /** 处理耗时 (ms) */
  durationMs?: number
}

/** TTS 事件类型 */
export type TTSEventType = 'start' | 'chunk' | 'end' | 'error'

/** TTS 事件 */
export interface TTSEvent {
  type: TTSEventType
  chunk?: string
  audioChunk?: ArrayBuffer
  error?: string
}

// ============================================================================
// 语音会话
// ============================================================================

/** 语音会话状态 */
export type VoiceSessionState = 'idle' | 'listening' | 'processing' | 'speaking' | 'interrupted'

/** 语音会话配置 */
export interface VoiceSessionConfig {
  /** VAD 配置 */
  vad?: Partial<VADConfig>
  /** STT 配置 */
  stt?: Partial<STTConfig>
  /** TTS 配置 */
  tts?: Partial<TTSConfig>
  /** 是否启用打断 */
  enableInterruption?: boolean
  /** 是否启用自动 VAD */
  enableAutoVAD?: boolean
  /** 引擎 id（从 VoiceRegistry 选取；缺省用 voice.json 默认选中项） */
  engineIds?: { stt?: string; tts?: string; vad?: string }
  /** 引擎直接注入（插件化；优先于 engineIds / Registry 解析） */
  engines?: {
    stt?: STTEngine
    tts?: TTSEngine
    vad?: (options: VADOptions) => VADController
    /** 函数式转写（自定义离线 STT 场景），缺省用 stt.transcribe */
    transcribe?: (audio: Float32Array) => Promise<string>
  }
  /** 一段语音识别完成后的回调（转发给 Agent / UI） */
  onUserSpeech?: (text: string) => void
}

/** 语音会话事件 */
export type VoiceSessionEventType = 
  | 'ready'
  | 'state_change'
  | 'transcript'
  | 'audio'
  | 'error'
  | 'interrupt'

/** 语音会话事件数据 */
export interface VoiceSessionEvent {
  type: VoiceSessionEventType
  state?: VoiceSessionState
  transcript?: STTResult
  audio?: ArrayBuffer
  error?: string
  /** turn 世代：每次用户语音开始 +1，接收方丢弃 generation < current 的事件 */
  generation?: number
  data?: unknown
}

// ============================================================================
// 打断机制
// ============================================================================

/** 打断配置 */
export interface InterruptionConfig {
  /** 打断灵敏度 (0-1) */
  sensitivity: number
  /** 打断后等待时间 (ms) */
  cooldownMs: number
  /** 是否自动恢复播放 */
  autoResume: boolean
}

/** 打断事件 */
export interface InterruptionEvent {
  type: 'interrupt_start' | 'interrupt_end' | 'interrupt_cancel'
  timestamp: number
  reason?: string
}

// ============================================================================
// 语音管理器
// ============================================================================

/** 语音管理器配置 */
export interface VoiceManagerConfig {
  /** 会话配置 */
  session?: VoiceSessionConfig
  /** 打断配置 */
  interruption?: Partial<InterruptionConfig>
  /** 是否启用日志 */
  enableLogging?: boolean
}

/** 语音管理器事件 */
export type VoiceManagerEventType = 
  | 'ready'
  | 'listening'
  | 'speaking'
  | 'transcript'
  | 'interrupt'
  | 'error'
  | 'end'

/** 语音管理器事件数据 */
export interface VoiceManagerEvent {
  type: VoiceManagerEventType
  data?: unknown
  error?: string
}
