/**
 * 口型同步引擎 — winner+runner 混合 + 指数攻/释放平滑
 *
 * 参考 airi `model-driver-lipsync/src/live2d/index.ts` 与 `stage-ui-three/src/composables/vrm/lip-sync.ts`：
 * - 只混合权重最大的两个元音（winner + runner），避免 A 大张开主导表情
 * - 非对称攻/释放平滑：开口 ATTACK、闭口 RELEASE（消除「机器人嘴」）
 * - 静音检测 + 空闲超时 → 嘴自然闭合
 *
 * 纯 TS，零 DOM / WebAudio 依赖，可直接单测；响度来源由调用方注入
 * （如 TTS 播放的 Analyser 或按帧音量）。
 */

export type LipKey = "A" | "E" | "I" | "O" | "U"

export interface LipSyncInput {
  /** 当前响度 0..1（若提供元音权重也可由权重推导峰值） */
  volume?: number
  /** 各元音权重投影（可选） */
  vowels?: Partial<Record<LipKey, number>>
  /** 当前时间戳 ms（缺省用 performance / Date） */
  timeMs?: number
}

export interface LipSyncOutput {
  /** 每元音平滑后的权重 0..1 */
  weights: Record<LipKey, number>
  /** 单一口开度 0..1（供 ParamMouthOpenY） */
  mouthOpen: number
  winner: LipKey
  runner: LipKey
}

export interface LipSyncOptions {
  /** 元音权重上限 */
  cap?: number
  /** 次元音相对主元音的加权比例 */
  runnerFactor?: number
  /** 次元音上限相对 cap 的比例 */
  runnerCapRatio?: number
  /** 响度归一化缩放 */
  volumeScale?: number
  /** 响度指数（软化峰值） */
  volumeExponent?: number
  /** 静音判定响度阈值 */
  silenceVolume?: number
  /** 静音判定元音阈值 */
  silenceGain?: number
  /** 空闲超时 ms */
  idleMs?: number
  /** 开口速度（每秒逼近率） */
  attack?: number
  /** 闭口速度（每秒逼近率） */
  release?: number
  /** 小于此值的权重置 0 */
  minWeight?: number
}

export const LIP_KEYS: LipKey[] = ["A", "E", "I", "O", "U"]

const DEFAULT_OPTIONS: Required<LipSyncOptions> = {
  cap: 0.7,
  runnerFactor: 0.6,
  runnerCapRatio: 0.5,
  volumeScale: 0.9,
  volumeExponent: 0.7,
  silenceVolume: 0.04,
  silenceGain: 0.05,
  idleMs: 160,
  attack: 50,
  release: 30,
  minWeight: 0.01,
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now()
}

export class LipSyncEngine {
  private options: Required<LipSyncOptions>
  private smooth: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
  private lastTimeMs: number | null = null
  private lastActiveAt: number | null = null

  constructor(options: LipSyncOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /** 推进一帧；返回平滑后的每元音权重与单一口开度 */
  update(input: LipSyncInput): LipSyncOutput {
    const t = input.timeMs ?? nowMs()
    if (this.lastTimeMs === null) this.lastTimeMs = t
    const dtSec = Math.max(0, (t - this.lastTimeMs) / 1000)
    this.lastTimeMs = t

    const o = this.options

    // 元音基值 + 峰值推导音量
    const baseVowels: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
    let peak = 0
    for (const k of LIP_KEYS) {
      const v = input.vowels?.[k] ?? 0
      baseVowels[k] = v
      if (v > peak) peak = v
    }
    const rawVol = input.volume ?? peak
    const amp = Math.min(rawVol * o.volumeScale, 1) ** o.volumeExponent

    // 2) 元音按响度缩放；无元音数据时使用默认口型分布回退（避免纯响度输入时张嘴不动）
    const DEFAULT_VOWEL_SHAPE: Record<LipKey, number> = { A: 0.6, E: 0.35, I: 0.8, O: 0.45, U: 0.3 }
    const projected: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
    let hasVowel = false
    for (const k of LIP_KEYS) {
      if ((input.vowels?.[k] ?? 0) > 0) hasVowel = true
    }
    for (const k of LIP_KEYS) {
      const shapeVal = hasVowel ? baseVowels[k] : DEFAULT_VOWEL_SHAPE[k]
      projected[k] = Math.min(o.cap, shapeVal * amp)
    }

    // 3) winner + runner（两最大权重）
    let winner: LipKey = "I"
    let runner: LipKey = "E"
    let winnerVal = -Infinity
    let runnerVal = -Infinity
    for (const k of LIP_KEYS) {
      const v = projected[k]
      if (v > winnerVal) {
        runnerVal = winnerVal
        runner = winner
        winnerVal = v
        winner = k
      } else if (v > runnerVal) {
        runnerVal = v
        runner = k
      }
    }

    // 4) 静音 + 空闲超时
    if (this.lastActiveAt === null) this.lastActiveAt = t - o.idleMs
    const silent = amp < o.silenceVolume || winnerVal < o.silenceGain
    if (!silent) this.lastActiveAt = t
    const idle = t - this.lastActiveAt > o.idleMs

    // 5) 目标权重
    const target: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 }
    if (!idle) {
      target[winner] = Math.min(o.cap, winnerVal)
      target[runner] = Math.min(o.cap * o.runnerCapRatio, runnerVal * o.runnerFactor)
    }

    // 6) 指数攻/释放平滑
    for (const k of LIP_KEYS) {
      const from = this.smooth[k]
      const to = target[k]
      const rate = 1 - Math.exp(-(to > from ? o.attack : o.release) * dtSec)
      const next = from + (to - from) * rate
      this.smooth[k] = next < o.minWeight ? 0 : next
    }

    const mouthOpen = Math.min(1, this.smooth[winner] + this.smooth[runner] * 0.3)

    return {
      weights: { ...this.smooth },
      mouthOpen,
      winner,
      runner,
    }
  }

  /** 重置状态（切换模型/会话时调用） */
  reset(): void {
    this.smooth = { A: 0, E: 0, I: 0, O: 0, U: 0 }
    this.lastTimeMs = null
    this.lastActiveAt = null
  }
}