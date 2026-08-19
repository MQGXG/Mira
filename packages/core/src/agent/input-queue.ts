/**
 * Inbox 投递队列 — 对齐 dsh 双边界投递模型
 *
 * 双边界：
 *  - next-step（steer）：当前步骤优先，插队到最前（立即干预正在做的事）
 *  - next-turn（user/queue）：独立回合，等当前回合跑完再处理
 *
 * 投递语义：
 *  - followup  → next-turn 队尾（追加独立回合）
 *  - steer     → next-step 最前（插队干预）
 *  - inject    → 指定边界入队但不唤醒（调用方负责不驱动 run）
 *
 * 消费：claim 默认 next-step 优先（steer 插队语义），空了再取 next-turn。
 * splice 钩子：每次变更（insert/delete）经 onSplice 通知，供事件广播与持久化接入。
 */

export type InputType = "user" | "steer" | "queue"

/** 投递边界：next-step（优先干预）或 next-turn（独立回合） */
export type InboxBoundary = "next-turn" | "next-step"

export interface QueueItem {
  message: string
  type: InputType
  /** 投递边界（steer 固定 next-step；user/queue 固定 next-turn） */
  boundary: InboxBoundary
  /** 可定位/丢弃身份（自动分配） */
  id: string
}

export type InboxSpliceOp =
  | { op: "insert"; boundary: InboxBoundary; index: number; item: { message: string; type: InputType }; id: string }
  | { op: "delete"; boundary: InboxBoundary; index: number; count: number }

/** 变更来源（投递/消费/丢弃/安静注入） */
export type InboxSpliceKind = "deliver" | "claim" | "discard" | "inject"

let nextItemId = 1

export class PendingInputQueue {
  private turnItems: QueueItem[] = []
  private stepItems: QueueItem[] = []
  /** 每次队列变更通知（事件广播 + 持久化接入点） */
  onSplice: ((op: InboxSpliceOp, kind: InboxSpliceKind) => void) | null = null

  private makeId(): string {
    return `inbox-${nextItemId++}`
  }

  /** 追加独立回合（next-turn 队尾） */
  followup(item: Omit<QueueItem, "id" | "boundary">): QueueItem {
    const q: QueueItem = { ...item, boundary: "next-turn", id: this.makeId() }
    this.turnItems.push(q)
    this.onSplice?.({ op: "insert", boundary: "next-turn", index: this.turnItems.length - 1, item, id: q.id }, "deliver")
    return q
  }

  /** 插队干预（next-step 最前） */
  steer(item: Omit<QueueItem, "id" | "boundary">): QueueItem {
    const q: QueueItem = { ...item, boundary: "next-step", id: this.makeId() }
    this.stepItems.unshift(q)
    this.onSplice?.({ op: "insert", boundary: "next-step", index: 0, item, id: q.id }, "deliver")
    return q
  }

  /** 安静投递：入队但不唤醒（调用方负责不驱动 run） */
  inject(item: Omit<QueueItem, "id" | "boundary">, boundary: InboxBoundary = "next-turn"): QueueItem {
    const q: QueueItem = { ...item, boundary, id: this.makeId() }
    const arr = boundary === "next-step" ? this.stepItems : this.turnItems
    arr.push(q)
    this.onSplice?.({ op: "insert", boundary, index: arr.length - 1, item, id: q.id }, "inject")
    return q
  }

  /** 兼容旧 API：按 type 分发（user/queue → followup；steer → steer） */
  push(item: Omit<QueueItem, "id" | "boundary"> & { type: InputType }): QueueItem {
    if (item.type === "steer") return this.steer(item)
    return this.followup(item)
  }

  pushMany(items: Array<Omit<QueueItem, "id" | "boundary"> & { type: InputType }>): QueueItem[] {
    return items.map(i => this.push(i))
  }

  /** 取出下一个任务（默认 next-step 优先；指定边界则仅从该边界取） */
  claim(target?: InboxBoundary): QueueItem | null {
    let q: QueueItem | undefined
    let boundary: InboxBoundary
    if (target === "next-step") {
      q = this.stepItems.shift()
      boundary = "next-step"
    } else if (target === "next-turn") {
      q = this.turnItems.shift()
      boundary = "next-turn"
    } else if (this.stepItems.length > 0) {
      q = this.stepItems.shift()
      boundary = "next-step"
    } else {
      q = this.turnItems.shift()
      boundary = "next-turn"
    }
    if (q === undefined) return null
    this.onSplice?.({ op: "delete", boundary, index: 0, count: 1 }, "claim")
    return q
  }

  /** 兼容旧 API：默认优先级取下一个 */
  next(): QueueItem | null {
    return this.claim()
  }

  /** 按身份丢弃一个任务 */
  discard(id: string): boolean {
    const pairs: Array<[QueueItem[], InboxBoundary]> = [[this.stepItems, "next-step"], [this.turnItems, "next-turn"]]
    for (const [arr, boundary] of pairs) {
      const idx = arr.findIndex(i => i.id === id)
      if (idx >= 0) {
        arr.splice(idx, 1)
        this.onSplice?.({ op: "delete", boundary, index: idx, count: 1 }, "discard")
        return true
      }
    }
    return false
  }

  hasPending(boundary?: InboxBoundary): boolean {
    if (boundary === "next-step") return this.stepItems.length > 0
    if (boundary === "next-turn") return this.turnItems.length > 0
    return this.stepItems.length > 0 || this.turnItems.length > 0
  }

  /** 查看待处理项（step 优先，返回副本） */
  peek(boundary?: InboxBoundary): QueueItem[] {
    if (boundary === "next-step") return [...this.stepItems]
    if (boundary === "next-turn") return [...this.turnItems]
    return [...this.stepItems, ...this.turnItems]
  }

  clear(): void {
    this.stepItems.length = 0
    this.turnItems.length = 0
  }

  get length(): number {
    return this.stepItems.length + this.turnItems.length
  }
}