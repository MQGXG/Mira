/**
 * 内置语音引擎工厂注册表（实现层）
 *
 * 按 kind 分派到具体工厂。VoiceRegistry（voice-catalog.ts）把
 * 引擎目录条目（VoiceEngineDef）交给此处创建实例。
 */

import type { STTEngineFactory, TTSEngineFactory, VADEngineFactory } from "../types"
import { createWhisperSTTEngine, DEFAULT_WHISPER_MODEL } from "./stt-whisper"
import { createWebSpeechSTTEngine } from "./stt-webspeech"
import { createKokoroTTSEngine, DEFAULT_KOKORO_MODEL } from "./tts-kokoro"
import { createWebSpeechTTSEngine } from "./tts-webspeech"
import { createEnergyVADEngine, DEFAULT_ENERGY_VAD_PARAMS } from "./vad-energy"

export { DEFAULT_WHISPER_MODEL, DEFAULT_KOKORO_MODEL, DEFAULT_ENERGY_VAD_PARAMS }

/** 内置实现名 → 工厂映射（用户/插件可用自定义 implementation 名扩展） */
export const BUILTIN_ENGINE_FACTORIES: {
  [implementation: string]:
    | { kind: "stt"; factory: STTEngineFactory }
    | { kind: "tts"; factory: TTSEngineFactory }
    | { kind: "vad"; factory: VADEngineFactory }
} = {
  whisper: { kind: "stt", factory: createWhisperSTTEngine },
  "webspeech-stt": { kind: "stt", factory: createWebSpeechSTTEngine },
  kokoro: { kind: "tts", factory: createKokoroTTSEngine },
  "webspeech-tts": { kind: "tts", factory: createWebSpeechTTSEngine },
  "energy-vad": { kind: "vad", factory: createEnergyVADEngine },
}