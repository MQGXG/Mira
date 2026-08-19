/**
 * 语音引擎获取层（UI 侧）— 目录驱动（一切皆插件）
 *
 * 经 IPC config:getVoiceCatalog 拿引擎目录（内置 + 用户 voice.json + 插件注册），
 * 用 core 引擎工厂按 implementation 构造实例；默认选中项取 voice.json defaults。
 *
 * renderer 不复制 VoiceRegistry 状态，仅按目录描述构建引擎实例（语义一致）。
 */

import {
  createWhisperSTTEngine,
  createWebSpeechSTTEngine,
  createKokoroTTSEngine,
  createWebSpeechTTSEngine,
  createEnergyVADEngine,
} from "@mira/core/voice"
import type { VoiceEngineDef, STTEngine, TTSEngine, VADOptions, VADController } from "@mira/core/voice"

export interface VoiceCatalogInfo {
  catalog: VoiceEngineDef[]
  defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>
}

let cache: VoiceCatalogInfo | null = null

/** 拉取语音引擎目录（IPC；缓存到 invalidate 或失效） */
export async function loadVoiceCatalog(): Promise<VoiceCatalogInfo> {
  if (!cache) {
    cache = await window.electronAPI.config.getVoiceCatalog()
  }
  return cache
}

/** 目录变更后调用（如保存 voice.json 后） */
export function invalidateVoiceCatalog(): void {
  cache = null
}

/** 按目录条目创建引擎实例（implementation → core 工厂） */
export function createEngineFromDef(def: VoiceEngineDef): STTEngine | TTSEngine | ((options: VADOptions) => VADController) {
  switch (def.implementation) {
    case "whisper": return createWhisperSTTEngine(def)
    case "webspeech-stt": return createWebSpeechSTTEngine(def)
    case "kokoro": return createKokoroTTSEngine(def)
    case "webspeech-tts": return createWebSpeechTTSEngine(def)
    case "energy-vad": return createEnergyVADEngine(def)
    default:
      throw new Error(`[voice] 未知引擎实现: ${def.implementation}`)
  }
}

function findDef(cat: VoiceCatalogInfo, kind: "stt" | "tts" | "vad", defaultKey: "stt" | "tts" | "vad" | "dictation", preferredId?: string): VoiceEngineDef | undefined {
  if (preferredId) {
    const d = cat.catalog.find((x) => x.id === preferredId && x.kind === kind)
    if (d) return d
  }
  const defaultId = cat.defaults[defaultKey]
  if (defaultId) {
    const d = cat.catalog.find((x) => x.id === defaultId && x.kind === kind)
    if (d) return d
  }
  return cat.catalog.find((x) => x.kind === kind)
}

/** 获取 TTS 引擎（默认选中；指定 id 优先） */
export async function getTTSEngine(id?: string): Promise<TTSEngine> {
  const cat = await loadVoiceCatalog()
  const def = findDef(cat, "tts", "tts", id)
  if (!def) throw new Error("[voice] 无可用 TTS 引擎")
  return createEngineFromDef(def) as TTSEngine
}

/** 获取 STT 引擎（实时对话转写用；默认选中或指定 id） */
export async function getSTTEngine(id?: string): Promise<STTEngine> {
  const cat = await loadVoiceCatalog()
  const def = findDef(cat, "stt", "stt", id)
  if (!def) throw new Error("[voice] 无可用 STT 引擎")
  return createEngineFromDef(def) as STTEngine
}

/** 获取听写引擎（VoiceInput 按住说话；优先 defaults.dictation） */
export async function getDictationEngine(id?: string): Promise<STTEngine> {
  const cat = await loadVoiceCatalog()
  const def = findDef(cat, "stt", "dictation", id)
  if (!def) throw new Error("[voice] 无可用听写引擎")
  return createEngineFromDef(def) as STTEngine
}

/** 获取 VAD 引擎构造器 */
export async function getVADEngine(id?: string): Promise<(options: VADOptions) => VADController> {
  const cat = await loadVoiceCatalog()
  const def = findDef(cat, "vad", "vad", id)
  if (!def) throw new Error("[voice] 无可用 VAD 引擎")
  return createEngineFromDef(def) as (options: VADOptions) => VADController
}

/** 保存默认引擎选中项到 voice.json（经 IPC） */
export async function saveVoiceDefaults(defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>): Promise<void> {
  await window.electronAPI.config.saveVoiceConfig(defaults)
  invalidateVoiceCatalog()
}