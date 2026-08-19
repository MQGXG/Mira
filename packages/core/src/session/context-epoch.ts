/**
 * Context Epoch — 上下文代际管理
 *
 * 参考 OpenCode 的 ContextEpoch 概念：将系统上下文与消息历史解耦。
 * 每个 Epoch 记录：
 * - baseline：系统提示基线（稳定前缀，可命中 prompt cache）
 * - baselineSeq：创建时的事件序列号（EventStore seq）
 * - snapshot：结构化快照（SourceManager fingerprints + StructuredSummary）
 *
 * 当 Epoch 变化时，只增量更新变化的 Source，而非替换整个 system prompt。
 */

import type { SourceFingerprint, SourceKey } from "./context-source"

/** Epoch 标识 */
export interface ContextEpoch {
  /** 会话 ID */
  sessionID: string
  /** Epoch 序号（单调递增） */
  epoch: number
  /** 创建时的 EventStore seq */
  baselineSeq: number
  /** 系统提示基线（稳定前缀） */
  baseline: string
  /** Source fingerprints 快照 */
  sourceSnapshot: Partial<Record<SourceKey, SourceFingerprint>>
  /** 目标/工作状态摘要（可选） */
  summary?: string
  /** 创建时间 */
  createdAt: string
}

/** Epoch 状态（运行时） */
export class ContextEpochTracker {
  private epochs = new Map<string, ContextEpoch[]>()
  private baselineSeqOf = new Map<string, number>()

  constructor() {}

  /**
   * 创建新 Epoch（或首次创建）
   * @param sessionID 会话 ID
   * @param baseline 系统提示基线
   * @param latestSeq 当前事件序列号
   * @param sourceSnapshot Source fingerprints
   */
  begin(
    sessionID: string,
    baseline: string,
    latestSeq: number,
    sourceSnapshot: Partial<Record<SourceKey, SourceFingerprint>> = {},
  ): ContextEpoch {
    const list = this.epochs.get(sessionID) || []
    const prev = list[list.length - 1]
    const epoch: ContextEpoch = {
      sessionID,
      epoch: (prev?.epoch || 0) + 1,
      baselineSeq: latestSeq,
      baseline,
      sourceSnapshot,
      createdAt: new Date().toISOString(),
    }
    list.push(epoch)
    // 仅保留最近 5 个 epoch，防止无界增长
    this.epochs.set(sessionID, list.slice(-5))
    this.baselineSeqOf.set(sessionID, latestSeq)
    return epoch
  }

  /**
   * 判断是否需要开始新 Epoch
   * 条件：事件数增长超过阈值，或系统提示基线变化
   */
  shouldBegin(
    sessionID: string,
    currentSeq: number,
    baselineChanged = false,
    eventsPerEpoch = 50,
  ): boolean {
    const prevSeq = this.baselineSeqOf.get(sessionID)
    if (prevSeq === undefined) return true
    if (baselineChanged) return true
    return currentSeq - prevSeq >= eventsPerEpoch
  }

  /** 获取当前（最新）Epoch */
  current(sessionID: string): ContextEpoch | undefined {
    const list = this.epochs.get(sessionID)
    return list?.[list.length - 1]
  }

  /** 获取 Epoch 历史（用于 UI 展示 / 回放） */
  history(sessionID: string): ContextEpoch[] {
    return this.epochs.get(sessionID) || []
  }

  /** 计算当前 epoch 与最新 seq 之间的增量事件数 */
  delta(sessionID: string, latestSeq: number): number {
    const epoch = this.current(sessionID)
    if (!epoch) return 0
    return Math.max(0, latestSeq - epoch.baselineSeq)
  }

  /** 清理会话的 Epoch 历史 */
  clear(sessionID: string): void {
    this.epochs.delete(sessionID)
    this.baselineSeqOf.delete(sessionID)
  }

  /** 全部清理 */
  clearAll(): void {
    this.epochs.clear()
    this.baselineSeqOf.clear()
  }

  /** 序列化为 JSON（供持久化） */
  toJSON(): { [sessionID: string]: ContextEpoch[] } {
    const result: { [sessionID: string]: ContextEpoch[] } = {}
    for (const [k, v] of this.epochs) result[k] = v
    return result
  }

  /** 从 JSON 恢复 */
  static fromJSON(data: { [sessionID: string]: ContextEpoch[] }): ContextEpochTracker {
    const tracker = new ContextEpochTracker()
    for (const [k, epochs] of Object.entries(data)) {
      if (!Array.isArray(epochs)) continue
      tracker.epochs.set(k, epochs)
      const last = epochs[epochs.length - 1]
      if (last) tracker.baselineSeqOf.set(k, last.baselineSeq)
    }
    return tracker
  }
}

/** 全局实例（进程内单例，随 Agent 生命周期） */
let globalTracker: ContextEpochTracker | null = null

export function getContextEpochTracker(): ContextEpochTracker {
  if (!globalTracker) {
    globalTracker = new ContextEpochTracker()
  }
  return globalTracker
}
