/**
 * 语音交互模块（renderer-safe 纯入口，无 Node 依赖）
 *
 * 渲染进程可安全 import（@mira/core/voice）：引擎接口/实现、音频工具、
 * 纯注册表、统一编排 VoiceSessionManager。
 *
 * Node 侧模块（fs 加载器 catalog-loader、VoiceActivityDetector、InterruptionManager、
 * AnnouncementWindow —— 依赖 Node events/fs）经 core/index.ts 单独导出。
 */

// 导出类型
export type {
  // 引擎接口（可插拔）
  STTType,
  TTSType,
  VoiceEngineKind,
  VoiceEngineImplementation,
  VoiceEngineDef,
  STTEngine,
  TTSEngine,
  VADResult,
  VADOptions,
  VADController,
  STTEngineFactory,
  TTSEngineFactory,
  VADEngineFactory,

  // VAD
  VADConfig,
  VADEvent,
  VADEventType,
  VADState,

  // STT
  STTConfig,
  STTResult,
  STTEvent,
  STTEventType,

  // TTS
  TTSConfig,
  TTSResult,
  TTSEvent,
  TTSEventType,

  // 语音会话
  VoiceSessionConfig,
  VoiceSessionState,
  VoiceSessionEvent,
  VoiceSessionEventType,

  // 打断
  InterruptionConfig,
  InterruptionEvent,

  // 语音管理器
  VoiceManagerConfig,
  VoiceManagerEvent,
  VoiceManagerEventType,
} from './types'

// 统一编排
export { VoiceSessionManager } from './voice-session'
export { LightEmitter } from './emitter'

// 引擎实现（BUILTIN_ENGINE_FACTORIES 由 VoiceRegistry 按 implementation 分派）
export { BUILTIN_ENGINE_FACTORIES } from './engines'
export {
  createWhisperSTTEngine,
  DEFAULT_WHISPER_MODEL,
} from './engines/stt-whisper'
export { createWebSpeechSTTEngine } from './engines/stt-webspeech'
export {
  createKokoroTTSEngine,
  DEFAULT_KOKORO_MODEL,
} from './engines/tts-kokoro'
export { createWebSpeechTTSEngine } from './engines/tts-webspeech'
export { createEnergyVADEngine, DEFAULT_ENERGY_VAD_PARAMS } from './engines/vad-energy'

// 引擎目录（纯注册表；目录数据经 IPC/loader 填充）
export { VoiceRegistry } from './registry'

// 音频/模型加载工具
export {
  float32ToAudioBuffer,
  playFloat32,
  startMicRecording,
  getCurrentVolume,
  recordChunk,
  mergeChunks,
} from './audio-utils'
export {
  loadASRPipeline,
  loadTTSPipeline,
  type ASRPipeline,
  type TTSPipeline,
} from './transformers-loader'