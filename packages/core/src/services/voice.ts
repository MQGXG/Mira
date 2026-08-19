/**
 * 语音服务 — ctx.voice
 * VoiceRegistry（全局注册表）的服务视图：目录装配 + 引擎工厂 + 默认选中项。
 * catalog 三层合并（内置 JSON → 用户 voice.json → 插件 registerEngine）统一经 initCatalog 装配。
 */

import { Service } from "../vendor/cordis/index"
import { VoiceRegistry } from "../voice/registry"
import { initVoiceCatalog } from "../voice/catalog-loader"
import type { VoiceEngineDef, VoiceEngineKind } from "../voice/types"
import type { VoiceService } from "../framework/context"

export class MiraVoiceService extends Service implements VoiceService {
  static provide = "voice"

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "voice")
  }

  initCatalog(): void {
    initVoiceCatalog()
  }

  listCatalog(): VoiceEngineDef[] {
    return VoiceRegistry.listCatalog()
  }

  getDefaults(): Partial<Record<"stt" | "tts" | "vad" | "dictation", string>> {
    return VoiceRegistry.getDefaults()
  }

  setDefaults(defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>): void {
    VoiceRegistry.setDefaults(defaults)
  }

  registerEngine(def: VoiceEngineDef): void {
    VoiceRegistry.registerEngine(def)
  }

  registerFactory(implementation: string, kind: VoiceEngineKind, factory: unknown): void {
    VoiceRegistry.registerFactory(implementation, kind, factory as never)
  }

  getSTTEngine(id?: string): unknown {
    return VoiceRegistry.getSTTEngine(id)
  }

  getTTSEngine(id?: string): unknown {
    return VoiceRegistry.getTTSEngine(id)
  }

  getVADEngine(id?: string): unknown {
    return VoiceRegistry.getVADEngine(id)
  }

  isInitialized(): boolean {
    return VoiceRegistry.isInitialized()
  }
}