/**
 * VoiceCatalog 加载器（Node 侧，生产链路）
 *
 * 负责 fs 读取引擎目录并灌入纯注册表 VoiceRegistry：
 *   1. 内置 `resources/models/voice-catalog.json`（打包经 electron-builder extraResources 分发）
 *   2. 用户 `~/.config/mira/voice.json`（defaults / engines / overrides）
 *
 * 渲染进程不可 import 本模块（Node fs 依赖）；renderer 经 IPC 拿目录后自行 registerEngine。
 */
import * as fs from "fs"
import * as path from "path"
import { VoiceRegistry } from "./registry"
import { loadUserVoiceConfig } from "../config/voice-config"
import type { VoiceEngineDef } from "./types"
import type { UserVoiceConfig } from "../config/voice-config"

function findCatalogPath(): string | null {
  const candidates: string[] = []
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(path.join(resourcesPath, "models", "voice-catalog.json"))
  candidates.push(path.join(process.cwd(), "resources", "models", "voice-catalog.json"))
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* 忽略不可访问路径 */ }
  }
  return null
}

/** 读取内置引擎目录（未注册；供 registry.registerBuiltins / IPC 分发） */
export function loadBuiltinVoiceCatalog(): VoiceEngineDef[] {
  const catalogPath = findCatalogPath()
  if (!catalogPath) {
    console.warn("[voice-catalog] voice-catalog.json 未找到，内置引擎目录为空")
    return []
  }
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as { engines?: unknown[] }
    const list = Array.isArray(raw.engines) ? raw.engines : []
    return list.filter((d): d is VoiceEngineDef => {
      const o = d as VoiceEngineDef | null | undefined
      return !!o
        && typeof o.id === "string"
        && typeof o.kind === "string"
        && typeof o.label === "string"
        && typeof o.implementation === "string"
        && (o.kind === "stt" || o.kind === "tts" || o.kind === "vad")
    })
  } catch (err) {
    console.warn("[voice-catalog] voice-catalog.json 解析失败:", err)
    return []
  }
}

/** 应用用户层 voice.json（defaults / engines / overrides）到注册表。幂等。 */
export function applyUserVoiceConfig(filePath?: string): void {
  const user: UserVoiceConfig = loadUserVoiceConfig(filePath)
  if (user.defaults) {
    VoiceRegistry.setDefaults({
      stt: user.defaults.stt,
      tts: user.defaults.tts,
      vad: user.defaults.vad,
      dictation: user.defaults.dictation,
    })
  }
  for (const def of user.engines || []) VoiceRegistry.registerEngine(def)
  for (const [id, ov] of Object.entries(user.overrides || {})) {
    const existing = VoiceRegistry.listCatalog().find((d) => d.id === id)
    if (!existing) continue
    if (ov.model) existing.model = ov.model
    if (ov.params) existing.params = { ...existing.params, ...ov.params }
  }
}

let initialized = false

/** 完整初始化入口：内置目录 + 用户层 voice.json；生产链路（主进程/sidecar）统一走此入口 */
export function initVoiceCatalog(): void {
  if (initialized) return
  VoiceRegistry.registerBuiltins(loadBuiltinVoiceCatalog())
  applyUserVoiceConfig()
  initialized = true
}