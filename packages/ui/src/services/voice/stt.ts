/**
 * STT 引擎工厂 — 薄代理到 core（@mira/core/voice）
 *
 * 保留 @mira/ui 公共 API 签名（向后兼容），实现全部委托给 core 引擎。
 * 新代码请用 services/voice/engine-registry（目录驱动）。
 */

import { createWebSpeechSTTEngine, createWhisperSTTEngine, DEFAULT_WHISPER_MODEL } from "@mira/core/voice"
import type { VoiceEngineDef } from "@mira/core/voice"
import type { STTEngine, STTType } from "./types"

/** Whisper 模型仓库 id（对齐 core DEFAULT_WHISPER_MODEL） */
export const WHISPER_MODEL = DEFAULT_WHISPER_MODEL

function sttDef(id: string, implementation: string): VoiceEngineDef {
  return { id, kind: "stt", label: id, implementation }
}

export function createLocalEngine(): STTEngine {
  return createWhisperSTTEngine(sttDef("whisper-base", "whisper"))
}

export function createWebSpeechEngine(): STTEngine {
  return createWebSpeechSTTEngine(sttDef("webspeech-stt", "webspeech-stt"))
}

export function createSTTEngine(type: STTType): STTEngine {
  if (type === "local") return createLocalEngine()
  return createWebSpeechEngine()
}