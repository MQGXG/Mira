/**
 * 索引进度追踪 — 监听 LSP 的 $/progress 通知判断项目索引是否就绪
 * 参考 Serena typescript_language_server.py 的 progress_handler（$ 前缀 token 跟踪）
 */

export interface IndexingState {
  /** 是否已无活跃索引任务 */
  complete: boolean
  /** 当前活跃 token 列表 */
  activeTokens: string[]
  /** 最近一条进度消息（诊断用） */
  lastMessage: string
}

/**
 * 索引状态追踪器
 * 由 LSPClient 分发 $/progress 通知，供查询前等待项目索引进度
 */
export class IndexingTracker {
  private activeTokens = new Set<string>()
  private _lastMessage = ""
  private waiters: Array<() => void> = []

  /** 开始一个索引进度任务（window/workDoneProgress/create 请求到达时调用） */
  begin(token: string): void {
    if (!token) return
    this.activeTokens.add(token)
  }

  /** 进度更新（$/progress begin/report/end 通知调用） */
  onProgress(token: string, kind: "begin" | "report" | "end", message?: string): void {
    if (!token) return
    if (message) this._lastMessage = message
    if (kind === "begin") {
      this.activeTokens.add(token)
    } else if (kind === "end") {
      this.activeTokens.delete(token)
      this.notifyWaiters()
    }
  }

  /** 当前是否处于空闲（无活跃索引任务） */
  get isIdle(): boolean {
    return this.activeTokens.size === 0
  }

  /** 当前索引状态快照 */
  get state(): IndexingState {
    return {
      complete: this.isIdle,
      activeTokens: [...this.activeTokens],
      lastMessage: this._lastMessage,
    }
  }

  /** 重置状态（服务器重启/关闭时调用） */
  reset(): void {
    this.activeTokens.clear()
    this._lastMessage = ""
    this.notifyWaiters()
  }

  /**
   * 等待索引就绪
   * @param timeoutMs 最大等待时间（毫秒）
   * @returns 索引已就绪返回 true；超时或已空闲返回 false（不阻塞主流程）
   */
  async waitForIndexing(timeoutMs: number): Promise<boolean> {
    // 当前无活跃任务，直接返回
    if (this.isIdle) return true

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done)
        resolve(false)
      }, timeoutMs)

      const done = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      this.waiters.push(done)
    })
  }

  private notifyWaiters(): void {
    if (!this.isIdle) return
    const pending = this.waiters
    this.waiters = []
    for (const waiter of pending) waiter()
  }
}

export const indexingTracker = new IndexingTracker()
