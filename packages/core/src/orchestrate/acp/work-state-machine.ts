/**
 * ACP Work 状态机
 * 参考 Qwen Audio Agent 的 Work 状态管理设计
 */

import { EventEmitter } from 'events'
import type {
  ACPWork,
  ACPWorkStatus,
  ACPPresentation,
  ACPDelegation,
  ACPEvent,
  ACPEventType,
} from './types'

// ============================================================================
// 状态转换定义
// ============================================================================

/** 有效的状态转换 */
const VALID_TRANSITIONS: Record<ACPWorkStatus, ACPWorkStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['delegated', 'finalizing', 'completed', 'failed', 'cancelled'],
  delegated: ['finalizing', 'completed', 'failed', 'cancelled'],
  finalizing: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}

// ============================================================================
// Work 状态机
// ============================================================================

/**
 * Work 状态机
 * 管理任务的生命周期和状态转换
 */
export class WorkStateMachine extends EventEmitter {
  /** 工作项存储 */
  private works: Map<string, ACPWork> = new Map()

  /** 事件历史 */
  private eventHistory: ACPEvent[] = []

  /** 最大事件历史长度 */
  private maxEventHistory: number = 1000

  /**
   * 创建新的工作项
   */
  createWork(params: {
    workId: string
    request: string
    objective: string
    agentId: string
    priority?: number
    dependencies?: string[]
  }): ACPWork {
    if (this.works.has(params.workId)) {
      throw new Error(`工作项 ${params.workId} 已存在`)
    }

    const now = Date.now()
    const work: ACPWork = {
      workId: params.workId,
      request: params.request,
      objective: params.objective,
      status: 'queued',
      agentId: params.agentId,
      createdAt: now,
      updatedAt: now,
      priority: params.priority || 0,
      dependencies: params.dependencies,
    }

    this.works.set(params.workId, work)
    this.emitEvent('task_created', work.workId, work.agentId, work)

    return work
  }

  /**
   * 更新工作状态
   */
  updateStatus(
    workId: string,
    newStatus: ACPWorkStatus,
    options?: {
      presentation?: ACPPresentation
      delegation?: ACPDelegation
      error?: string
    },
  ): ACPWork {
    const work = this.works.get(workId)
    if (!work) {
      throw new Error(`工作项 ${workId} 不存在`)
    }

    const validNext = VALID_TRANSITIONS[work.status]
    if (!validNext.includes(newStatus)) {
      throw new Error(
        `无效的状态转换: ${work.status} → ${newStatus}`,
      )
    }

    const now = Date.now()
    const previousStatus = work.status

    // 更新状态
    work.status = newStatus
    work.updatedAt = now

    // 根据状态更新其他字段
    if (newStatus === 'completed') {
      work.completedAt = now
      work.result = options?.presentation
    } else if (newStatus === 'failed') {
      work.error = options?.error || '未知错误'
    } else if (newStatus === 'delegated' && options?.delegation) {
      work.delegation = options.delegation
    }

    // 发送状态变更事件
    this.emitEvent('task_updated', workId, work.agentId, {
      previousStatus,
      currentStatus: newStatus,
      work,
    })

    // 根据最终状态发送对应事件
    if (newStatus === 'completed') {
      this.emitEvent('task_completed', workId, work.agentId, work)
    } else if (newStatus === 'failed') {
      this.emitEvent('task_failed', workId, work.agentId, {
        work,
        error: work.error,
      })
    } else if (newStatus === 'cancelled') {
      this.emitEvent('task_cancelled', workId, work.agentId, work)
    }

    return work
  }

  /**
   * 获取工作项
   */
  getWork(workId: string): ACPWork | undefined {
    return this.works.get(workId)
  }

  /**
   * 获取所有工作项
   */
  getAllWorks(): ACPWork[] {
    return Array.from(this.works.values())
  }

  /**
   * 按状态筛选工作项
   */
  getWorksByStatus(status: ACPWorkStatus): ACPWork[] {
    return this.getAllWorks().filter(work => work.status === status)
  }

  /**
   * 获取活跃的工作项 (未完成/未取消)
   */
  getActiveWorks(): ACPWork[] {
    return this.getAllWorks().filter(
      work => !['completed', 'failed', 'cancelled'].includes(work.status),
    )
  }

  /**
   * 按优先级排序的工作项
   */
  getWorksByPriority(): ACPWork[] {
    return this.getActiveWorks().sort((a, b) => 
      (b.priority || 0) - (a.priority || 0),
    )
  }

  /**
   * 检查依赖是否满足
   */
  checkDependencies(workId: string): {
    ready: boolean
    blockedBy: string[]
  } {
    const work = this.works.get(workId)
    if (!work) {
      return { ready: false, blockedBy: [] }
    }

    if (!work.dependencies?.length) {
      return { ready: true, blockedBy: [] }
    }

    const blockedBy: string[] = []
    for (const depId of work.dependencies) {
      const depWork = this.works.get(depId)
      if (depWork && depWork.status !== 'completed') {
        blockedBy.push(depId)
      }
    }

    return {
      ready: blockedBy.length === 0,
      blockedBy,
    }
  }

  /**
   * 取消工作项
   */
  cancelWork(workId: string): ACPWork {
    return this.updateStatus(workId, 'cancelled')
  }

  /**
   * 批量取消
   */
  cancelAllWorks(): ACPWork[] {
    const activeWorks = this.getActiveWorks()
    return activeWorks.map(work => this.cancelWork(work.workId))
  }

  /**
   * 重置工作项 (仅限已完成/失败/取消的状态)
   */
  resetWork(workId: string): ACPWork {
    const work = this.works.get(workId)
    if (!work) {
      throw new Error(`工作项 ${workId} 不存在`)
    }

    if (!['completed', 'failed', 'cancelled'].includes(work.status)) {
      throw new Error(`只能重置已完成/失败/取消的工作项`)
    }

    const now = Date.now()
    work.status = 'queued'
    work.updatedAt = now
    work.completedAt = undefined
    work.result = undefined
    work.error = undefined
    work.delegation = undefined

    this.emitEvent('task_updated', workId, work.agentId, {
      previousStatus: 'completed',
      currentStatus: 'queued',
      work,
    })

    return work
  }

  /**
   * 删除工作项
   */
  deleteWork(workId: string): boolean {
    const work = this.works.get(workId)
    if (!work) {
      return false
    }

    if (!['completed', 'failed', 'cancelled'].includes(work.status)) {
      throw new Error(`只能删除已完成/失败/取消的工作项`)
    }

    return this.works.delete(workId)
  }

  /**
   * 清理已完成的工作项
   */
  cleanup(maxAge?: number): number {
    const now = Date.now()
    const toDelete: string[] = []

    for (const [workId, work] of this.works) {
      if (['completed', 'failed', 'cancelled'].includes(work.status)) {
        if (!maxAge || now - (work.completedAt || work.updatedAt) > maxAge) {
          toDelete.push(workId)
        }
      }
    }

    for (const workId of toDelete) {
      this.works.delete(workId)
    }

    return toDelete.length
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number
    byStatus: Record<ACPWorkStatus, number>
    avgCompletionTime: number
  } {
    const allWorks = this.getAllWorks()
    const byStatus: Record<ACPWorkStatus, number> = {
      queued: 0,
      running: 0,
      delegated: 0,
      finalizing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    }

    let totalCompletionTime = 0
    let completedCount = 0

    for (const work of allWorks) {
      byStatus[work.status]++
      if (work.status === 'completed' && work.completedAt) {
        totalCompletionTime += work.completedAt - work.createdAt
        completedCount++
      }
    }

    return {
      total: allWorks.length,
      byStatus,
      avgCompletionTime: completedCount > 0 
        ? totalCompletionTime / completedCount 
        : 0,
    }
  }

  /**
   * 获取事件历史
   */
  getEventHistory(options?: {
    limit?: number
    eventType?: ACPEventType
    workId?: string
  }): ACPEvent[] {
    let events = [...this.eventHistory]

    if (options?.eventType) {
      events = events.filter(e => e.type === options.eventType)
    }

    if (options?.workId) {
      events = events.filter(e => e.taskId === options.workId)
    }

    if (options?.limit) {
      events = events.slice(-options.limit)
    }

    return events
  }

  /**
   * 发送事件
   */
  private emitEvent(
    type: ACPEventType,
    taskId: string,
    agentId: string,
    data: unknown,
  ): void {
    const event: ACPEvent = {
      type,
      taskId,
      agentId,
      data,
      timestamp: Date.now(),
    }

    this.eventHistory.push(event)

    // 限制事件历史长度
    if (this.eventHistory.length > this.maxEventHistory) {
      this.eventHistory = this.eventHistory.slice(-this.maxEventHistory)
    }

    this.emit(type, event)
    this.emit('event', event)
  }
}

// ============================================================================
// 全局实例
// ============================================================================

/** 全局 Work 状态机实例 */
export const globalWorkStateMachine = new WorkStateMachine()

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 生成工作 ID
 */
export function generateWorkId(prefix?: string): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 8)
  return prefix ? `${prefix}_${timestamp}_${random}` : `work_${timestamp}_${random}`
}

/**
 * 检查状态是否为终态
 */
export function isTerminalStatus(status: ACPWorkStatus): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status)
}

/**
 * 检查状态是否为活跃状态
 */
export function isActiveStatus(status: ACPWorkStatus): boolean {
  return !isTerminalStatus(status)
}

/**
 * 获取状态的中文描述
 */
export function getStatusLabel(status: ACPWorkStatus): string {
  const labels: Record<ACPWorkStatus, string> = {
    queued: '排队中',
    running: '执行中',
    delegated: '已委派',
    finalizing: '完成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return labels[status]
}

/**
 * 获取状态的颜色 (用于 UI)
 */
export function getStatusColor(status: ACPWorkStatus): string {
  const colors: Record<ACPWorkStatus, string> = {
    queued: '#6b7280',      // 灰色
    running: '#3b82f6',     // 蓝色
    delegated: '#8b5cf6',   // 紫色
    finalizing: '#f59e0b',  // 黄色
    completed: '#10b981',   // 绿色
    failed: '#ef4444',      // 红色
    cancelled: '#6b7280',   // 灰色
  }
  return colors[status]
}
