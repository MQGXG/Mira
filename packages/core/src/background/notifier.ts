/**
 * 后台任务播报门控（Backend Result Announcer）
 *
 * 参考 qwen-audio-agent `task-manager.mjs` 的 notification 生命周期：
 * 后台任务（定时任务、cron、异步操作）完成后产生"待播报"通知，
 * 但只在插话安全窗口（AnnouncementWindow.isBlocked() === false）内开口，
 * 避免覆盖用户当前对话或排队音频。
 *
 * 纯 TS 零依赖，可单测。与 `voice/announcement-window.ts` 协作。
 */

export interface BackgroundNotification {
  id: string
  title: string
  /** 播报文本（正文） */
  message: string
  /** 播报用 TTS 文本（可含自然语言包装） */
  speech: string
  status: "pending" | "delivering" | "delivered" | "failed"
  createdAt: number
  claimedAt: number | null
  deliveredAt: number | null
}

export interface AnnouncementGate {
  isBlocked(): boolean
}

export interface BackgroundNotifierOptions {
  /** 插话安全窗口（未提供则视为永不阻塞） */
  window?: AnnouncementGate
  /** 待播报通知 TTL（毫秒） */
  pendingTtlMs?: number
  /** 最多保留的已送达通知数 */
  maxDelivered?: number
  /** 播报文本生成：默认用 message 原样 */
  speechFor?: (title: string, message: string) => string
}

/** 参考 qwen：后台任务分类 → 播报动词 */
const VERBS: Record<string, string> = {
  completed: "已完成",
  failed: "失败了",
  cancelled: "已取消",
  progress: "正在更新",
}

/**
 * 后台任务播报门控。
 *
 * - `addNotification`：后台任务完成时登记一条待播报通知
 * - `claimReady`：在安全窗口内取出可播报的通知（按时间序，最多 1 条）
 * - `markDelivered`：播放结束后确认送达（清理待播队列）
 */
export class BackgroundNotifier {
  private notifications = new Map<string, BackgroundNotification>()
  private window?: AnnouncementGate
  private pendingTtlMs: number
  private maxDelivered: number
  private speechFor: (title: string, message: string) => string

  constructor(options: BackgroundNotifierOptions = {}) {
    this.window = options.window
    this.pendingTtlMs = options.pendingTtlMs ?? 604_800_000
    this.maxDelivered = options.maxDelivered ?? 50
    this.speechFor = options.speechFor ?? ((_title, message) => message)
  }

  /** 是否可开口（安全窗口开放且有待播报通知） */
  canAnnounce(): boolean {
    return !this.window || !this.window.isBlocked()
  }

  /**
   * 后台任务完成时登记通知。返回通知快照。
   */
  addNotification(title: string, message: string, opts: { status?: BackgroundNotification["status"]; id?: string } = {}): BackgroundNotification {
    this.prune()
    const id = opts.id ?? `notify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const notification: BackgroundNotification = {
      id,
      title,
      message,
      speech: this.speechFor(title, message),
      status: opts.status ?? "pending",
      createdAt: Date.now(),
      claimedAt: null,
      deliveredAt: null,
    }
    this.notifications.set(id, notification)
    return { ...notification }
  }

  /** 便捷：任务完成（带结果分类） */
  addTaskResult(kind: "completed" | "failed" | "cancelled", objective: string, result?: string): BackgroundNotification {
    const verb = VERBS[kind] || "已完成"
    const title = `${objective.slice(0, 80)}`
    const message = result ? `${title} ${verb}：${result}` : `${title} ${verb}`
    return this.addNotification(title, message, { status: kind === "failed" ? "pending" : "pending" })
  }

  /**
   * 在安全窗口内取出下一条可播报通知（FIFO）。
   * 窗口阻塞时返回 null（通知保留，稍后重试）。
   */
  claimReady(): BackgroundNotification | null {
    if (!this.canAnnounce()) return null
    const pending = Array.from(this.notifications.values())
      .filter((n) => n.status === "pending")
      .sort((a, b) => a.createdAt - b.createdAt)
    if (pending.length === 0) return null
    const next = pending[0]
    next.status = "delivering"
    next.claimedAt = Date.now()
    return { ...next }
  }

  /** 播放确认送达 */
  markDelivered(id: string): boolean {
    const n = this.notifications.get(id)
    if (!n || n.status !== "delivering") return false
    n.status = "delivered"
    n.deliveredAt = Date.now()
    return true
  }

  /** 播放失败 → 退回 pending（稍后重试） */
  retry(id: string): boolean {
    const n = this.notifications.get(id)
    if (!n || n.status !== "delivering") return false
    n.status = "pending"
    n.claimedAt = null
    return true
  }

  /** 待播报通知数 */
  get pendingCount(): number {
    return Array.from(this.notifications.values()).filter((n) => n.status === "pending" || n.status === "delivering").length
  }

  /** 列出全部通知（快照） */
  list(): BackgroundNotification[] {
    this.prune()
    return Array.from(this.notifications.values())
      .map((n) => ({ ...n }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 清理过期 pending 通知 + 裁剪已送达上限 */
  private prune(): void {
    const now = Date.now()
    for (const [id, n] of this.notifications) {
      if (n.status === "pending" && now - n.createdAt > this.pendingTtlMs) {
        this.notifications.delete(id)
      }
    }
    const delivered = Array.from(this.notifications.values())
      .filter((n) => n.status === "delivered")
      .sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0))
    for (const n of delivered.slice(this.maxDelivered)) {
      this.notifications.delete(n.id)
    }
  }
}

/** 与 AnnouncementWindow 的适配器 */
export function createNotifierWithWindow(
  window: AnnouncementGate | undefined,
  options: Omit<BackgroundNotifierOptions, "window"> = {},
): BackgroundNotifier {
  return new BackgroundNotifier({ ...options, window })
}
