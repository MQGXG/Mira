/**
 * Ebbinghaus 遗忘曲线
 * 模拟人类记忆的自然衰减过程
 *
 * 公式：R = e^(-t/S)
 *   R = 记忆保留率
 *   t = 时间（小时）
 *   S = 记忆强度（越大衰减越慢）
 */

/** 计算记忆保留率 */
export function retentionRate(hoursSinceAccess: number, strength: number): number {
  if (strength <= 0) return 0
  return Math.exp(-hoursSinceAccess / (strength * 100))
}

/** 计算衰减后的记忆强度 */
export function decayStrength(
  currentStrength: number,
  hoursSinceAccess: number,
  decayRate: number
): number {
  if (currentStrength <= 0) return 0
  const decayed = currentStrength * Math.exp(-decayRate * hoursSinceAccess)
  return Math.max(0, decayed)
}

/** 计算需要多少小时才能衰减到目标强度 */
export function hoursToDecay(
  currentStrength: number,
  targetStrength: number,
  decayRate: number
): number {
  if (currentStrength <= targetStrength) return 0
  if (decayRate <= 0) return Infinity
  return -Math.log(targetStrength / currentStrength) / decayRate
}

/** 计算访问后的强度增强 */
export function consolidationStrength(
  currentStrength: number,
  accessCount: number,
  baseImportance: number
): number {
  // 香农熵：每次访问的增强效果递减
  const diminishingReturn = Math.log2(accessCount + 1) / 10
  const boost = diminishingReturn * baseImportance
  return Math.min(1.0, currentStrength + boost)
}

/** 计算关联强度增强 */
export function associationBoost(
  nodeStrength: number,
  neighborStrength: number,
  edgeStrength: number
): number {
  // 强邻居的关联更有可能被强化
  const baseBoost = neighborStrength * edgeStrength * 0.1
  // 当前节点越强，关联增强效果越明显
  const synergy = nodeStrength * baseBoost
  return Math.min(0.2, synergy)
}

/** 批量计算多个节点的衰减 */
export function batchDecay<T extends { strength: number; lastAccessed: Date; decayConfig: { decayRate: number; minStrength: number } }>(
  nodes: T[],
  now: Date = new Date()
): T[] {
  return nodes.map(node => {
    const hours = (now.getTime() - node.lastAccessed.getTime()) / (1000 * 60 * 60)
    const newStrength = decayStrength(node.strength, hours, node.decayConfig.decayRate)
    const clampedStrength = Math.max(node.decayConfig.minStrength, newStrength)
    return {
      ...node,
      strength: clampedStrength,
    }
  })
}

/** 遗忘曲线可视化数据（用于前端图表） */
export function forgettingCurveData(
  initialStrength: number,
  decayRate: number,
  hours: number = 168, // 一周
  points: number = 100
): Array<{ hour: number; retention: number }> {
  const data: Array<{ hour: number; retention: number }> = []
  const step = hours / points

  for (let i = 0; i <= points; i++) {
    const hour = i * step
    const retention = retentionRate(hour, initialStrength)
    data.push({ hour, retention: retention * 100 })
  }

  return data
}

/** 多次复习后的遗忘曲线（间隔重复效果） */
export function spacedRepetitionCurve(
  intervals: number[], // 复习间隔（小时）
  initialStrength: number,
  decayRate: number,
  totalHours: number = 168
): Array<{ hour: number; retention: number }> {
  const data: Array<{ hour: number; retention: number }> = []
  const step = totalHours / 100
  let currentStrength = initialStrength

  for (let hour = 0; hour <= totalHours; hour += step) {
    // 检查是否到达复习点
    for (const interval of intervals) {
      if (Math.abs(hour - interval) < step / 2) {
        // 复习增强强度
        currentStrength = consolidationStrength(currentStrength, 1, 0.8)
      }
    }

    const retention = retentionRate(step, currentStrength)
    data.push({ hour, retention: retention * 100 })
    currentStrength *= Math.exp(-decayRate * step)
  }

  return data
}
