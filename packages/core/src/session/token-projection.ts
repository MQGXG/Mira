/**
 * TokenUsageProjection — 四桶 token 投影（对齐 dsh token-meter）
 *
 * 将 LLM 上报的 usage 拆分为互斥（DISJOINT）四桶：
 *   - uncachedInputTokens  未命中缓存的输入（全价）
 *   - outputTokens         输出（全价）
 *   - cacheReadTokens      命中缓存的输入（便宜）
 *   - cacheWriteTokens     写入缓存的输入（按写入价）
 *
 * promptTokens（总输入，含缓存）→ uncachedInput = promptTokens - cacheRead - cacheWrite。
 * 与 dsh 的 TokenUsage 约定一致："billed input = sum of the three"。
 */

export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** 单个 turn 的 usage 样本（turn/step 用于同一步骤重复上报的替换去重） */
export interface UsageSample {
  turn: number
  step: number
  usage: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}

export interface TokenUsageState {
  totals: TokenUsageProjection
  last: UsageSample | null
}

const safe = (v: number | undefined): number => (Number.isFinite(v) && (v ?? 0) > 0 ? Math.max(0, v!) : 0)

export const zeroBuckets = (): TokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** 从原始 usage 拆分四桶（promptTokens 视为含缓存的总额） */
export const bucketsFrom = (usage: {
  promptTokens?: number
  completionTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): TokenUsageProjection => {
  const prompt = safe(usage.promptTokens)
  const cacheRead = safe(usage.cacheReadTokens)
  const cacheWrite = safe(usage.cacheWriteTokens)
  return {
    uncachedInputTokens: Math.max(0, prompt - cacheRead - cacheWrite),
    outputTokens: safe(usage.completionTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

const addBuckets = (a: TokenUsageProjection, b: TokenUsageProjection): TokenUsageProjection => ({
  uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
})

const subBuckets = (a: TokenUsageProjection, b: TokenUsageProjection): TokenUsageProjection => ({
  uncachedInputTokens: Math.max(0, a.uncachedInputTokens - b.uncachedInputTokens),
  outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
  cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
  cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
})

const bucketsEqual = (a: TokenUsageProjection, b: TokenUsageProjection): boolean =>
  a.uncachedInputTokens === b.uncachedInputTokens
  && a.outputTokens === b.outputTokens
  && a.cacheReadTokens === b.cacheReadTokens
  && a.cacheWriteTokens === b.cacheWriteTokens

/**
 * TokenUsageAccumulator — 会话级 token 累计器
 *
 * 输入按 turn/step 去重：同一步骤的重复上报（流式 usage chunk 早到 + finish 最终值）
 * 替换旧值而非重复累加，避免双重计数。totals 输出累计四桶。
 */
export class TokenUsageAccumulator {
  private state: TokenUsageState = { totals: zeroBuckets(), last: null }

  /** 累加一次 usage（同 turn/step 重复上报时替换） */
  add(sample: UsageSample): TokenUsageProjection {
    const buckets = bucketsFrom(sample.usage)
    const prev = this.state.last
      && this.state.last.turn === sample.turn
      && this.state.last.step === sample.step
      ? this.state.last.usage
      : undefined

    const prevBuckets = prev ? bucketsFrom(prev) : undefined
    let totals: TokenUsageProjection
    if (prevBuckets && bucketsEqual(prevBuckets, buckets)) {
      totals = this.state.totals
    } else if (prevBuckets) {
      totals = addBuckets(subBuckets(this.state.totals, prevBuckets), buckets)
    } else {
      totals = addBuckets(this.state.totals, buckets)
    }

    this.state = { totals, last: sample }
    return totals
  }

  get totals(): TokenUsageProjection {
    return this.state.totals
  }

  reset(): void {
    this.state = { totals: zeroBuckets(), last: null }
  }
}

/**
 * ContextPressureTracker — 上下文占用（prompt 侧）实测跟踪
 *
 * 对齐 dsh contextPressureProjection：记录最近一次请求的 provider 实测
 * prompt 占用（pressureTokens = 总输入，含缓存流量），供压缩决策校准
 * 本地估算值。contextWindow 可选记录 provider 上下文窗口。
 */
export interface ContextPressure {
  pressureTokens?: number
  contextWindow?: number
}

export class ContextPressureTracker {
  private state: ContextPressure = {}

  /** 记录一次请求的实测占用（usage.promptTokens 视为含缓存的 prompt 侧总占用） */
  record(usage: { promptTokens?: number }, contextWindow?: number): void {
    const pressureTokens = safe(usage.promptTokens)
    if (pressureTokens > 0) this.state = { ...this.state, pressureTokens }
    if (contextWindow !== undefined && contextWindow > 0) this.state = { ...this.state, contextWindow }
  }

  get pressure(): ContextPressure {
    return { ...this.state }
  }

  reset(): void {
    this.state = {}
  }
}
