/**
 * TTS 引擎工厂 — 薄代理到 core（@mira/core/voice）
 *
 * 保留 @mira/ui 公共 API 签名（向后兼容），实现全部委托给 core 引擎。
 * 新代码请用 services/voice/engine-registry（目录驱动）。
 */

import { createKokoroTTSEngine, createWebSpeechTTSEngine } from "@mira/core/voice"
import type { VoiceEngineDef } from "@mira/core/voice"
import type { TTSEngine, TTSType } from "./types"

function ttsDef(id: string, implementation: string): VoiceEngineDef {
  return { id, kind: "tts", label: id, implementation }
}

export function createWebSpeechEngine(): TTSEngine {
  return createWebSpeechTTSEngine(ttsDef("webspeech-tts", "webspeech-tts"))
}

export function createLocalEngine(): TTSEngine {
  return createKokoroTTSEngine(ttsDef("kokoro", "kokoro"))
}

export function createTTSEngine(type: TTSType): TTSEngine {
  if (type === "local") return createLocalEngine()
  return createWebSpeechEngine()
}

export function createDefaultTTSEngine(): TTSEngine {
  return createWebSpeechEngine()
}