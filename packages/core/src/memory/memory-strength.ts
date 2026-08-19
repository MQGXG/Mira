/**
 * 记忆强度计算引擎
 * 综合考虑：基础重要性、访问频率、时间衰减、关联奖励
 */

import type { MemoryNode, DecayConfig } from "./memory-node"
import { decayStrength, consolidationStrength, associationBoost } from "./decay-curve"

/** 强度计算权重 */
export interface StrengthWeights {
  /** 基础重要性权重 */
  importance: number
  /** 访问频率权重 */
  frequency: number
  /** 时间衰减权重 */
  decay: number
  /** 关联奖励权重 */
  association: number
}

/** 默认权重配置 */
export const DEFAULT_WEIGHTS: StrengthWeights = {
  importance: 0.3,
  frequency: 0.2,
  decay: 0.3,
  association: 0.2,
}

/** 计算记忆强度 */
export function calculateStrength(
  node: MemoryNode,
  now: Date = new Date(),
  weights: StrengthWeights = DEFAULT_WEIGHTS
): number {
  const hoursSinceAccess = (now.getTime() - node.lastAccessed.getTime()) / (1000 * 60 * 60)

  // 1. 基础重要性分量
  const importanceScore = node.importance

  // 2. 访问频率分量（归一化到 0-1）
  const frequencyScore = Math.min(1.0, node.accessCount / 100)

  // 3. 时间衰减分量
  const decayedStrength = decayStrength(
    node.strength,
    hoursSinceAccess,
    node.decayConfig.decayRate
  )
  const decayScore = Math.max(node.decayConfig.minStrength, decayedStrength)

  // 4. 关联奖励分量（基于邻居的强度）
  let associationScore = 0
  if (node.relatedNodes.length > 0 && node.associationStrengths.size > 0) {
    const avgAssociation = Array.from(node.associationStrengths.values())
      .reduce((a, b) => a + b, 0) / node.associationStrengths.size
    associationScore = avgAssociation
  }

  // 加权计算
  const rawStrength =
    importanceScore * weights.importance +
    frequencyScore * weights.frequency +
    decayScore * weights.decay +
    associationScore * weights.association

  // 限制在 0-1 范围内
  return Math.max(0, Math.min(1.0, rawStrength))
}

/** 批量计算记忆强度 */
export function batchCalculateStrength(
  nodes: MemoryNode[],
  now: Date = new Date(),
  weights: StrengthWeights = DEFAULT_WEIGHTS
): Map<string, number> {
  const results = new Map<string, number>()

  for (const node of nodes) {
    results.set(node.id, calculateStrength(node, now, weights))
  }

  return results
}

/** 更新记忆强度（访问后） */
export function updateStrengthAfterAccess(
  node: MemoryNode,
  now: Date = new Date()
): MemoryNode {
  const hoursSinceAccess = (now.getTime() - node.lastAccessed.getTime()) / (1000 * 60 * 60)

  // 计算衰减
  const decayed = decayStrength(
    node.strength,
    hoursSinceAccess,
    node.decayConfig.decayRate
  )

  // 访问后增强（固化）
  const enhanced = consolidationStrength(
    decayed,
    node.accessCount + 1,
    node.importance
  )

  // 关联奖励
  let associationBonus = 0
  if (node.relatedNodes.length > 0) {
    for (const neighborId of node.relatedNodes) {
      const neighborStr = node.associationStrengths.get(neighborId) || 0
      associationBonus += associationBoost(node.strength, neighborStr, 0.5)
    }
    associationBonus = Math.min(0.2, associationBonus)
  }

  return {
    ...node,
    strength: Math.min(1.0, enhanced + associationBonus),
    accessCount: node.accessCount + 1,
    lastAccessed: now,
  }
}

/** 更新关联强度 */
export function updateAssociationStrength(
  node: MemoryNode,
  neighborId: string,
  edgeStrength: number
): MemoryNode {
  const current = node.associationStrengths.get(neighborId) || 0
  const newStrength = Math.min(1.0, current + edgeStrength * 0.1)

  return {
    ...node,
    associationStrengths: new Map(node.associationStrengths).set(neighborId, newStrength),
  }
}

/** 标记记忆为遗忘（低于阈值） */
export function markAsForgotten(
  node: MemoryNode,
  now: Date = new Date()
): MemoryNode {
  const hoursSinceAccess = (now.getTime() - node.lastAccessed.getTime()) / (1000 * 60 * 60)

  const decayed = decayStrength(
    node.strength,
    hoursSinceAccess,
    node.decayConfig.decayRate
  )

  if (decayed < node.decayConfig.minStrength) {
    return {
      ...node,
      strength: node.decayConfig.minStrength,
      metadata: {
        ...node.metadata,
        forgotten: true,
        forgottenAt: now.toISOString(),
      },
    }
  }

  return node
}

/** 检查记忆是否被遗忘 */
export function isForgotten(node: MemoryNode, now: Date = new Date()): boolean {
  return node.strength <= node.decayConfig.minStrength
}

/** 检查记忆是否应该被固化（强化） */
export function shouldConsolidate(node: MemoryNode): boolean {
  return node.strength >= node.decayConfig.consolidationThreshold &&
    node.accessCount >= 5
}

/** 计算记忆排名分数（用于排序） */
export function rankScore(
  node: MemoryNode,
  now: Date = new Date(),
  queryRelevance: number = 0.5
): number {
  const strength = calculateStrength(node, now)
  const relevance = queryRelevance

  // 排名分数 = 强度 × 0.4 + 相关性 × 0.4 + 访问次数归一化 × 0.2
  const frequency = Math.min(1.0, node.accessCount / 50)
  return strength * 0.4 + relevance * 0.4 + frequency * 0.2
}
