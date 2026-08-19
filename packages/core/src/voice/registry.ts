/**
 * VoiceRegistry — 语音引擎注册表（纯内存，无 Node 依赖，渲染进程可 import）
 *
 * 引擎目录条目（VoiceEngineDef）由外部加载：
 *  - Node 侧：catalog-loader.initVoiceCatalog()（内置 JSON + 用户 voice.json，生产链路）
 *  - 渲染进程：经 IPC config:getVoiceCatalog 拿到目录后逐个 registerEngine
 *
 * 工厂（implementation → 实例工厂）由 BUILTIN_ENGINE_FACTORIES 播种，插件可扩展。
 */
import { BUILTIN_ENGINE_FACTORIES } from "./engines"
import type {
  STTEngine,
  TTSEngine,
  VADController,
  VADOptions,
  STTEngineFactory,
  TTSEngineFactory,
  VADEngineFactory,
  VoiceEngineDef,
  VoiceEngineKind,
} from "./types"

type EngineFactory = STTEngineFactory | TTSEngineFactory | VADEngineFactory

const KINDS: ReadonlySet<VoiceEngineKind> = new Set(["stt", "tts", "vad"])

class VoiceRegistryImpl {
  private defs = new Map<string, VoiceEngineDef>()
  /** implementation 名 → 工厂（含 kind，校验用） */
  private factories = new Map<string, { kind: VoiceEngineKind; factory: EngineFactory }>()
  private sttCache = new Map<string, STTEngine>()
  private ttsCache = new Map<string, TTSEngine>()
  private defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>> = {}
  private initialized = false

  /** 幂等：播种内置工厂 + 注册内置引擎目录（列表由外部注入，Node 读 JSON / renderer 经 IPC） */
  registerBuiltins(engineList: VoiceEngineDef[] = []): void {
    if (this.initialized) return
    for (const [impl, entry] of Object.entries(BUILTIN_ENGINE_FACTORIES)) {
      this.factories.set(impl, entry)
    }
    for (const def of engineList) this.registerEngine(def)
    this.initialized = true
  }

  /** 插件扩展实现工厂（自定义 implementation 名） */
  registerFactory(implementation: string, kind: VoiceEngineKind, factory: EngineFactory): void {
    this.factories.set(implementation, { kind, factory })
  }

  /** 注册引擎条目；implementation 对应工厂不存在时拒绝 */
  registerEngine(def: VoiceEngineDef): boolean {
    if (!def || typeof def.id !== "string" || !KINDS.has(def.kind)) return false
    if (!this.factories.has(def.implementation)) return false
    this.defs.set(def.id, { ...def, params: { ...def.params } })
    return true
  }

  /** 解析 kind 对应的引擎条目：指定 id → defaults[kind] → kind 内第一个 */
  private getDef(id: string | undefined, kind: VoiceEngineKind): VoiceEngineDef | undefined {
    if (id) {
      const d = this.defs.get(id)
      if (d && d.kind === kind) return d
    }
    const preferred = this.defaults[kind]
    if (preferred) {
      const p = this.defs.get(preferred)
      if (p && p.kind === kind) return p
    }
    for (const d of this.defs.values()) if (d.kind === kind) return d
    return undefined
  }

  /** 创建 STT 引擎实例（单例缓存） */
  private createSTT(def: VoiceEngineDef): STTEngine | undefined {
    const cached = this.sttCache.get(def.id)
    if (cached) return cached
    const entry = this.factories.get(def.implementation)
    if (!entry || entry.kind !== "stt") return undefined
    const engine = (entry.factory as STTEngineFactory)(def)
    this.sttCache.set(def.id, engine)
    return engine
  }

  /** 创建 TTS 引擎实例（单例缓存） */
  private createTTS(def: VoiceEngineDef): TTSEngine | undefined {
    const cached = this.ttsCache.get(def.id)
    if (cached) return cached
    const entry = this.factories.get(def.implementation)
    if (!entry || entry.kind !== "tts") return undefined
    const engine = (entry.factory as TTSEngineFactory)(def)
    this.ttsCache.set(def.id, engine)
    return engine
  }

  /** 获取 STT 引擎；指定 id 不可用时自动回退到 kind 内第一个可用引擎 */
  getSTTEngine(id?: string): STTEngine | undefined {
    const def = this.getDef(id, "stt")
    if (!def) return undefined
    const engine = this.createSTT(def)
    if (engine && engine.isAvailable()) return engine
    for (const d of this.defs.values()) {
      if (d.kind !== "stt" || d.id === def.id) continue
      const e = this.createSTT(d)
      if (e && e.isAvailable()) return e
    }
    return undefined
  }

  /** 获取 TTS 引擎；指定 id 不可用时自动回退到 kind 内第一个可用引擎 */
  getTTSEngine(id?: string): TTSEngine | undefined {
    const def = this.getDef(id, "tts")
    if (!def) return undefined
    const engine = this.createTTS(def)
    if (engine && engine.isAvailable()) return engine
    for (const d of this.defs.values()) {
      if (d.kind !== "tts" || d.id === def.id) continue
      const e = this.createTTS(d)
      if (e && e.isAvailable()) return e
    }
    return undefined
  }

  /** 获取 VAD 引擎构造器（带运行时 options；VAD 无单例，每次构造独立控制器） */
  getVADEngine(id?: string): ((options: VADOptions) => VADController) | undefined {
    const def = this.getDef(id, "vad")
    if (!def) return undefined
    const entry = this.factories.get(def.implementation)
    if (!entry || entry.kind !== "vad") return undefined
    return (entry.factory as VADEngineFactory)(def)
  }

  /** 当前默认选中项（voice.json defaults + 内存更新） */
  getDefaults(): Partial<Record<"stt" | "tts" | "vad" | "dictation", string>> {
    return { ...this.defaults }
  }

  /** 设置默认选中项（内存；持久化由保存 IPC 写 voice.json） */
  setDefaults(defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>): void {
    this.defaults = { ...defaults }
  }

  /** 引擎目录（供 UI/IPC 展示；含用户/插件注册与 overrides 后的最终状态） */
  listCatalog(): VoiceEngineDef[] {
    return Array.from(this.defs.values()).map((d) => ({ ...d, params: { ...d.params } }))
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

/** 全局单例（Node 与渲染进程共享同一状态语义；renderer 经 IPC 填充目录） */
export const VoiceRegistry = new VoiceRegistryImpl()