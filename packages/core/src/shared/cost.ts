/**
 * 会话成本计算 — 参考 opencode session.ts getUsage
 *
 * 根据 LLM 返回的 usage 和模型定价，计算单次调用的美元成本。
 * 公式（价格单位：美元 / 百万 token）：
 *   cost = input × inputPrice + output × outputPrice
 *        + cacheRead × cacheReadPrice + cacheWrite × cacheWritePrice
 *        + reasoning × outputPrice（reasoning 按输出价计）
 *
 * 注意：input tokens 通常已包含 cache read/write，计算成本时分开计价避免重复。
 */

import pricingSnapshot from "../assets/models-pricing.json"

/** models.dev 定价快照条目（美元/千 token） */
interface SnapshotPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

const PRICING_SNAPSHOT = pricingSnapshot as Record<string, SnapshotPricing>

/** 单次 LLM 调用用量 */
export interface UsageRecord {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** 模型定价（美元 / 百万 token） */
export interface ModelPricing {
  inputPer1K: number
  outputPer1K: number
  /** 缓存读取单价（通常为输入的 1/10） */
  cacheReadPer1K?: number
  /** 缓存写入单价 */
  cacheWritePer1K?: number
}

/** 成本计算结果 */
export interface CostResult {
  cost: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

/**
 * 计算单次调用的成本
 * @param usage LLM 返回的 usage
 * @param pricing 模型定价（美元/千 token）
 */
export function calculateCost(usage: UsageRecord, pricing: ModelPricing): CostResult {
  const input = Math.max(0, usage.promptTokens || 0)
  const output = Math.max(0, usage.completionTokens || 0)
  const cacheRead = Math.max(0, usage.cacheReadTokens || 0)
  const cacheWrite = Math.max(0, usage.cacheWriteTokens || 0)

  // input 中扣除缓存部分，避免重复计费（cache read/write 单独计价）
  const freshInput = Math.max(0, input - cacheRead - cacheWrite)

  const inputCost = freshInput * pricing.inputPer1K / 1000
  const outputCost = output * pricing.outputPer1K / 1000
  const cacheReadCost = cacheRead * (pricing.cacheReadPer1K ?? pricing.inputPer1K * 0.1) / 1000
  const cacheWriteCost = cacheWrite * (pricing.cacheWritePer1K ?? pricing.inputPer1K) / 1000

  return {
    cost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: Math.max(0, usage.totalTokens || (input + output)),
  }
}

/**
 * 累计两个成本结果（用于会话级汇总）
 */
export function addCostResults(a: CostResult, b: CostResult): CostResult {
  return {
    cost: a.cost + b.cost,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/**
 * 内置模型的默认定价（美元/千 token）
 * 参考 opencode models.dev + provider 官方定价
 */
const DEFAULT_PRICES: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  "gpt-4o": { input: 0.0025, output: 0.01, cacheRead: 0.00125 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006, cacheRead: 0.000075 },
  "gpt-4-turbo": { input: 0.01, output: 0.03, cacheRead: 0.005 },
  "gpt-4": { input: 0.03, output: 0.06 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  "o1": { input: 0.015, output: 0.06 },
  "o3-mini": { input: 0.0011, output: 0.0044 },
  "claude-sonnet-4-20250514": { input: 0.003, output: 0.015, cacheRead: 0.0027, cacheWrite: 0.00375 },
  "claude-opus-4-20250514": { input: 0.015, output: 0.075, cacheRead: 0.0135, cacheWrite: 0.01875 },
  "claude-haiku-4-20250514": { input: 0.001, output: 0.005, cacheRead: 0.0009, cacheWrite: 0.00125 },
  "claude-4-20250514": { input: 0.005, output: 0.025, cacheRead: 0.0045, cacheWrite: 0.00625 },
  "deepseek-chat": { input: 0.00027, output: 0.0011, cacheRead: 0.000027 },
  "deepseek-reasoner": { input: 0.00055, output: 0.00219, cacheRead: 0.000055 },
  "deepseek-v4-flash": { input: 0.00027, output: 0.0011, cacheRead: 0.000027 },
}

/**
 * 根据模型 ID 获取定价（美元/千 token）
 * 优先读取 models.dev 定价快照，其次 DEFAULT_PRICES 兜底，未知模型用通用估算
 */
export function getModelPricing(modelId: string): ModelPricing {
  const fromSnapshot = PRICING_SNAPSHOT[modelId]
  if (fromSnapshot) {
    return {
      inputPer1K: fromSnapshot.input,
      outputPer1K: fromSnapshot.output,
      cacheReadPer1K: fromSnapshot.cacheRead,
      cacheWritePer1K: fromSnapshot.cacheWrite,
    }
  }
  const known = DEFAULT_PRICES[modelId]
  if (known) {
    return {
      inputPer1K: known.input,
      outputPer1K: known.output,
      cacheReadPer1K: known.cacheRead,
      cacheWritePer1K: known.cacheWrite,
    }
  }
  // 未知模型：保守估算（输入 $0.001/K，输出 $0.004/K）
  return { inputPer1K: 0.001, outputPer1K: 0.004 }
}

/** 格式化成本为美元字符串 */
export function formatCost(cost: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(cost)
  } catch {
    return `$${cost.toFixed(4)}`
  }
}

/** 格式化 token 数为千分位 */
export function formatTokens(n: number): string {
  return n.toLocaleString("en-US")
}
