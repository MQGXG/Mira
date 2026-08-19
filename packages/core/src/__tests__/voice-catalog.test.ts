/**
 * VoiceRegistry + voice-config 测试（一切皆插件：引擎目录三层合并）
 *
 * 隔离策略：核心断言走 registerBuiltins（不触发用户 voice.json）；
 * 涉及 defaults 选择的方法内部会 initVoiceCatalog（含用户层），
 * 因此对目录内容采用存在性断言（容忍用户 voice.json 干扰）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, test } from "vitest"
import { VoiceRegistry } from "../voice/registry"
import { loadBuiltinVoiceCatalog, applyUserVoiceConfig } from "../voice/catalog-loader"
import {
  getGlobalVoiceConfigPath,
  loadUserVoiceConfig,
} from "../config/voice-config"
import type { STTEngine, TTSEngine, VADController, VADOptions, VoiceEngineDef } from "../voice/types"

/** 模拟一帧间隔（VAD dt 基于真实流逝时间） */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("VoiceRegistry", () => {
  test('registerBuiltins 幂等且加载内置目录（2 STT / 2 TTS / 1 VAD）', () => {
    VoiceRegistry.registerBuiltins(loadBuiltinVoiceCatalog())
    const n1 = VoiceRegistry.listCatalog().length
    VoiceRegistry.registerBuiltins(loadBuiltinVoiceCatalog())
    const n2 = VoiceRegistry.listCatalog().length
    expect(n2).toBe(n1)
    expect(n2).toBeGreaterThanOrEqual(5)

    const catalog = VoiceRegistry.listCatalog()
    const ids = new Set(catalog.map((d) => d.id))
    expect(ids).toContain("whisper-base")
    expect(ids).toContain("webspeech-stt")
    expect(ids).toContain("kokoro")
    expect(ids).toContain("webspeech-tts")
    expect(ids).toContain("energy-vad")

    expect(catalog.filter((d) => d.kind === "stt").length).toBeGreaterThanOrEqual(2)
    expect(catalog.filter((d) => d.kind === "tts").length).toBeGreaterThanOrEqual(2)
    expect(catalog.filter((d) => d.kind === "vad").length).toBeGreaterThanOrEqual(1)
  })

  test('内置 VAD 引擎可构造控制器并按能量触发状态切换', async () => {
    VoiceRegistry.registerBuiltins(loadBuiltinVoiceCatalog())
    const factory = VoiceRegistry.getVADEngine("energy-vad")
    expect(factory).toBeTypeOf("function")

    const events: boolean[] = []
    // VAD 以帧驱动（dt 基于真实流逝时间），注入小阈值参数以缩短测试
    const vad: VADController = factory!({
      speechDurationMs: 100,
      silenceDurationMs: 200,
      onStateChange: (r) => events.push(r.speaking),
    })

    // 连续高音量（>= speechThreshold）累计达到 speechDurationMs → speaking
    for (let i = 0; i < 10; i++) { vad.process(0.1); await sleep(16) }
    expect(events.at(-1)).toBe(true)

    // 连续低音量达到 silenceDurationMs → 结束
    for (let i = 0; i < 20; i++) { vad.process(0.001); await sleep(16) }
    expect(events.at(-1)).toBe(false)

    // 阈值参数可被运行时 options 覆盖
    let thresholdHit = false
    const strict = VoiceRegistry.getVADEngine("energy-vad")!({
      speechThreshold: 0.9,
      silenceThreshold: 0.8,
      speechDurationMs: 100,
      onStateChange: (r) => { if (r.speaking) thresholdHit = true },
    })
    for (let i = 0; i < 10; i++) { strict.process(0.5); await sleep(16) }
    expect(thresholdHit).toBe(false)
    for (let i = 0; i < 10; i++) { strict.process(0.95); await sleep(16) }
    expect(thresholdHit).toBe(true)
  })

  test('registerFactory + registerEngine 注册自定义引擎（插件扩展）', () => {
    VoiceRegistry.registerBuiltins(loadBuiltinVoiceCatalog())
    VoiceRegistry.registerFactory("mock-stt", "stt", () => ({
      type: "local",
      isAvailable: () => true,
      start: () => {},
      stop: () => {},
    }))
    VoiceRegistry.registerFactory("mock-tts", "tts", () => ({
      type: "local",
      isAvailable: () => true,
      speak: async () => {},
      stop: () => {},
    }))

    const def: VoiceEngineDef = {
      id: "mock-voice", kind: "stt", label: "Mock STT", implementation: "mock-stt",
    }
    expect(VoiceRegistry.registerEngine(def)).toBe(true)

    const stt = VoiceRegistry.getSTTEngine("mock-voice")
    expect(stt).toBeDefined()
    expect(stt!.type).toBe("local")

    // 未知 implementation 拒绝注册
    const bad: VoiceEngineDef = {
      id: "bad", kind: "stt", label: "Bad", implementation: "not-exists",
    }
    expect(VoiceRegistry.registerEngine(bad)).toBe(false)
  })

  test('setDefaults 影响无参引擎选择', () => {
    VoiceRegistry.registerBuiltins(loadBuiltinVoiceCatalog())
    VoiceRegistry.registerFactory("mock-stt2", "stt", () => ({
      type: "local",
      isAvailable: () => true,
      start: () => {},
      stop: () => {},
    }))
    VoiceRegistry.registerEngine({
      id: "mock-default-stt", kind: "stt", label: "Default", implementation: "mock-stt2",
    })
    VoiceRegistry.setDefaults({ stt: "mock-default-stt" })

    const engine = VoiceRegistry.getSTTEngine()
    expect(engine).toBeDefined()
    expect(VoiceRegistry.getDefaults().stt).toBe("mock-default-stt")

    // TTS 引擎单例缓存：同一 id 两次获取同一实例
    const tts1 = VoiceRegistry.getTTSEngine("webspeech-tts")
    const tts2 = VoiceRegistry.getTTSEngine("webspeech-tts")
    expect(tts1).toBe(tts2)
  })
})

describe("voice-config", () => {
  test('loadUserVoiceConfig 解析完整结构', () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-voice-"))
    const file = join(dir, "voice.json")
    try {
      writeFileSync(file, JSON.stringify({
        defaults: { stt: "whisper-small", tts: "kokoro", vad: "energy-vad", dictation: "webspeech-stt" },
        engines: [{ id: "whisper-small", kind: "stt", label: "小模型", implementation: "whisper", model: "onnx-community/whisper-small" }],
        overrides: { "whisper-small": { params: { language: "en" } } },
      }), "utf-8")

      const cfg = loadUserVoiceConfig(file)
      expect(cfg.defaults?.stt).toBe("whisper-small")
      expect(cfg.engines?.length).toBe(1)
      expect(cfg.engines?.[0].model).toBe("onnx-community/whisper-small")
      expect(cfg.overrides?.["whisper-small"]?.params?.language).toBe("en")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('loadUserVoiceConfig 文件缺失/损坏返回空配置（不抛错）', () => {
    const dir = mkdtempSync(join(tmpdir(), "mira-voice-"))
    try {
      expect(loadUserVoiceConfig(join(dir, "missing.json"))).toEqual({ defaults: {}, engines: [], overrides: {} })

      const bad = join(dir, "bad.json")
      writeFileSync(bad, "{ not json", "utf-8")
      expect(loadUserVoiceConfig(bad)).toEqual({ defaults: {}, engines: [], overrides: {} })

      // 非法引擎条目被过滤
      const mixed = join(dir, "mixed.json")
      writeFileSync(mixed, JSON.stringify({
        engines: [{ id: "ok", kind: "tts", label: "OK", implementation: "kokoro" }, { id: "bad" }],
      }), "utf-8")
      const cfg = loadUserVoiceConfig(mixed)
      expect(cfg.engines?.length).toBe(1)
      expect(cfg.engines?.[0].id).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('getGlobalVoiceConfigPath 指向 ~/.config/mira/voice.json', () => {
    const p = getGlobalVoiceConfigPath()
    expect(p).toMatch(/voice\.json$/)
    expect(p).toContain(".config")
  })
})

// 类型参考（确保 STTEngine/TTSEngine/VADOptions 形状与 UI 侧兼容）
const _sttShape: STTEngine = { type: "local", isAvailable: () => true, start: () => {}, stop: () => {} }
const _ttsShape: TTSEngine = { type: "local", isAvailable: () => true, speak: async () => {}, stop: () => {} }
const _vadShape: VADOptions = { onStateChange: () => {} }
void _sttShape
void _ttsShape
void _vadShape