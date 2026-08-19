/**
 * 用户语音配置加载（一切皆插件：用户层 JSON 数据源）
 *
 * 全局文件：`~/.config/mira/voice.json`（与 models.json 同根）
 *
 * 结构：
 * ```json
 * {
 *   "defaults": { "stt": "whisper-base", "tts": "kokoro", "vad": "energy-vad", "dictation": "webspeech-stt" },
 *   "engines": [ ...完整 VoiceEngineDef（新增引擎，含自定义 implementation 名）... ],
 *   "overrides": { "whisper-base": { "model": "onnx-community/whisper-small", "params": { "language": "zh-CN" } } }
 * }
 * ```
 * 加载结果由 VoiceRegistry 应用（registerEngine + overrides 合并）。
 * 注意：UI 开关（voiceChatEnabled）保留 localStorage，不在此文件。
 */
import * as fs from "fs"
import * as path from "path"
import { homedir } from "os"
import type { VoiceEngineDef } from "../voice/types"

export interface UserVoiceConfig {
  /** 默认选中的引擎 id（设置面板写入；缺省取内置目录首个同 kind 条目） */
  defaults?: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>
  /** 完整引擎定义（新增引擎或整体覆盖内置，含自定义 implementation） */
  engines?: VoiceEngineDef[]
  /** 对已注册引擎的增量覆盖（模型 id / 参数） */
  overrides?: Record<string, { model?: string; params?: Record<string, unknown> }>
}

export function getGlobalVoiceConfigPath(): string {
  return path.join(homedir(), ".config", "mira", "voice.json")
}

function isValidEngine(d: unknown): d is VoiceEngineDef {
  const o = d as VoiceEngineDef | null | undefined
  return !!o
    && typeof o.id === "string"
    && typeof o.kind === "string"
    && typeof o.label === "string"
    && typeof o.implementation === "string"
}

/** 读取并解析用户语音配置；文件不存在 / 解析失败返回空配置（不抛错） */
export function loadUserVoiceConfig(filePath: string = getGlobalVoiceConfigPath()): UserVoiceConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as UserVoiceConfig
    const defaults =
      raw.defaults && typeof raw.defaults === "object" && !Array.isArray(raw.defaults)
        ? raw.defaults
        : {}
    const engines = Array.isArray(raw.engines) ? raw.engines.filter(isValidEngine) : []
    const overrides =
      raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)
        ? raw.overrides
        : {}
    return { defaults, engines, overrides }
  } catch {
    return { defaults: {}, engines: [], overrides: {} }
  }
}

/** 合并并持久化默认引擎选中项到 voice.json（保留已有 engines/overrides） */
export function saveUserVoiceDefaults(
  defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>,
  filePath: string = getGlobalVoiceConfigPath(),
): UserVoiceConfig {
  const existing = loadUserVoiceConfig(filePath)
  const next: UserVoiceConfig = {
    defaults: { ...existing.defaults, ...defaults },
    engines: existing.engines || [],
    overrides: existing.overrides || {},
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf-8")
  } catch (err) {
    console.warn("[voice-config] 保存 voice.json 失败:", err)
  }
  return next
}