/**
 * RunCoordinator — 执行协调器
 *
 * 对标 opencode 的 RunCoordinator 设计。
 * 序列化每个 session 的执行，Coalesced Wakeup，Interrupt+Restart。
 * 解决并发输入导致的状态竞争问题。
 */

import type { AgentEvent } from "../types"
import type { AgentConfig } from "./agent"

// ── 类型定义 ────────────────────────────────────────────

/** 执行状态 */
export type RunState = "idle" | "running" | "interrupted" | "coalescing"

/** 单次执行请求 */
export interface RunRequest {
  id: string
  userMessage: string
  config: AgentConfig
  /** 用于收集结果的回调 */
  emit: (event: AgentEvent) => void
  /** Agent 执行函数 */
  execute: () => AsyncGenerator<AgentEvent>
}

/** 协调器状态快照 */
export interface CoordinatorSnapshot {
  state: RunState
  pendingCount: number
  coalescedCount: number
  currentRequestId: string | null
}

// ── RunCoordinator ──────────────────────────────────────

export class RunCoordinator {
  private state: RunState = "idle"
  private currentRequest: RunRequest | null = null
  private pendingRequests: RunRequest[] = []
  private coalescedMessages: string[] = []
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private coalesceWindowMs = 200
  private requestIdCounter = 0

  /** 提交新的执行请求 */
  submit(request: Omit<RunRequest, "id">): string {
    const id = `run_${++this.requestIdCounter}_${Date.now().toString(36)}`
    const fullRequest: RunRequest = { ...request, id }

    if (this.state === "idle") {
      // 空闲 → 直接执行
      this.execute(fullRequest)
      return id
    }

    if (this.state === "running") {
      // 正在执行 → 判断是否 coalesce
      if (this.canCoalesce(fullRequest)) {
        this.coalescedMessages.push(fullRequest.userMessage)
        this.scheduleCoalescedWakeup()
        return id
      }
      // 不能合并 → 入队等待
      this.pendingRequests.push(fullRequest)
      return id
    }

    if (this.state === "coalescing") {
      // 正在合并中 → 追加到合并队列
      this.coalescedMessages.push(fullRequest.userMessage)
      this.scheduleCoalescedWakeup()
      return id
    }

    if (this.state === "interrupted") {
      // 被中断 → 入队等待
      this.pendingRequests.push(fullRequest)
      return id
    }

    return id
  }

  /**
   * 中断当前执行（steer 语义）
   * 通知当前执行中断，保留 pending 输入
   */
  interrupt(reason: string): void {
    if (this.state !== "running") return
    this.state = "interrupted"
    this.currentRequest?.emit({
      type: "thinking",
      text: `⚡ Interrupted: ${reason}`,
    })
  }

  /**
   * 唤醒执行 — 处理队列中的下一个请求
   */
  wake(): void {
    if (this.state === "idle" && this.pendingRequests.length > 0) {
      const next = this.pendingRequests.shift()!
      this.execute(next)
    }
  }

  /**
   * 获取当前状态快照
   */
  getSnapshot(): CoordinatorSnapshot {
    return {
      state: this.state,
      pendingCount: this.pendingRequests.length,
      coalescedCount: this.coalescedMessages.length,
      currentRequestId: this.currentRequest?.id || null,
    }
  }

  /**
   * 获取当前状态
   */
  getState(): RunState {
    return this.state
  }

  /**
   * 获取待处理请求数量
   */
  getPendingCount(): number {
    return this.pendingRequests.length
  }

  /**
   * 获取合并消息数量
   */
  getCoalescedCount(): number {
    return this.coalescedMessages.length
  }

  /**
   * 重置到空闲状态（用于错误恢复）
   */
  reset(): void {
    this.state = "idle"
    this.currentRequest = null
    this.pendingRequests = []
    this.coalescedMessages = []
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = null
    }
  }

  // ── 私有方法 ──────────────────────────────────────────

  /**
   * 判断两条消息是否可以合并
   */
  private canCoalesce(newRequest: RunRequest): boolean {
    // 简单策略：同一 session 的 user 消息可以合并
    return this.currentRequest?.config.sessionID === newRequest.config.sessionID
  }

  /**
   * 调度 Coalesced Wakeup
   */
  private scheduleCoalescedWakeup(): void {
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer)
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null
      this.wakeWithCoalesced()
    }, this.coalesceWindowMs)
  }

  /**
   * 执行合并后的消息
   */
  private wakeWithCoalesced(): void {
    if (this.coalescedMessages.length === 0) return
    const merged = this.coalescedMessages.join("\n\n")
    this.coalescedMessages = []

    // 将合并消息作为 steer 推入当前执行
    if (this.currentRequest && this.state === "running") {
      this.currentRequest.emit({
        type: "thinking",
        text: `📥 Coalesced ${merged.length} chars of input`,
      })
    }
  }

  /**
   * 执行请求
   */
  private async execute(request: RunRequest): Promise<void> {
    this.state = "running"
    this.currentRequest = request

    try {
      // 执行 Agent 运行
      for await (const event of request.execute()) {
        request.emit(event)
      }
    } catch (error) {
      request.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.state = "idle"
      this.currentRequest = null

      // 处理队列中的下一个请求
      if (this.pendingRequests.length > 0) {
        const next = this.pendingRequests.shift()!
        this.execute(next)
      }
    }
  }
}
