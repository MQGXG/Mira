/**
 * 记忆服务 — ctx.memory
 * 对齐 dsh ctx.memory seam：6 层 Provider 统一调度 + 全文搜索 + 写入
 */

import { Service } from "../vendor/cordis/index"
import { MemoryManager } from "../memory/manager"
import type { MemoryService } from "../framework/context"

export class MiraMemoryService extends Service implements MemoryService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "memory"
  private manager: MemoryManager | null = null

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "memory")
  }

  /** 初始化 6 层 Provider（需 workspace） */
  async initialize(sessionID: string, workspace: string): Promise<void> {
    this.manager = new MemoryManager()
    await this.manager.initialize(sessionID, workspace)
  }

  async search(query: string, limit?: number): Promise<string> {
    const fts = this.manager?.getFTSProvider()
    if (!fts) return ""
    return limit ? fts.searchMemory(query, limit) : fts.search(query)
  }

  async remember(content: string, sessionId: string): Promise<void> {
    const fts = this.manager?.getFTSProvider()
    fts?.remember(content, sessionId)
  }

  /** 召回选择（按 token 预算注入系统提示） */
  async selectMemories(messages: unknown[], sessionID: string, tokenBudget = 1500): Promise<string> {
    if (!this.manager) return ""
    return this.manager.selectMemories(messages, sessionID, tokenBudget)
  }

  async shutdown(): Promise<void> {
    await this.manager?.shutdown()
    this.manager = null
  }
}
