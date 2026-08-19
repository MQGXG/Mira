/**
 * 记忆服务 — ctx.memory
 * 对齐 dsh ctx.memory seam：5 层 Provider 统一调度 + 全文搜索 + 写入。
 * 根源修复：provider 链原在 Agent 构造硬编码（agent.ts:320-324）→
 * 迁入本服务 initialize 装配；插件可 registerProvider 扩展/替换（可逆）。
 */

import { Service } from "../vendor/cordis/index"
import { MemoryManager } from "../memory/manager"
import { BuiltinMemoryProvider } from "../memory/builtin-provider"
import { CheckpointProvider } from "../memory/checkpoint-provider"
import { FileMemoryProvider } from "../memory/file-memory-provider"
import { FTSMemoryProvider } from "../memory/fts-memory-provider"
import type { MemoryProvider } from "../memory/types"
import type { MemoryService } from "../framework/context"

export class MiraMemoryService extends Service implements MemoryService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "memory"
  private manager: MemoryManager | null = null
  /** 默认链组件引用（vector 惰性：嵌入式可用时才装配） */
  private defaultProviders: MemoryProvider[] = []

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "memory")
  }

  /**
   * 初始化并装配默认 5 层 Provider 链（builtin/checkpoint/file/fts/vector）。
   * 原 Agent 构造硬编码逻辑迁移至此；workspace 缺失时跳过 file/fts/vector。
   */
  async initialize(sessionID: string, workspace: string): Promise<void> {
    if (this.manager) {
      await this.manager.initialize(sessionID, workspace)
      return
    }
    const manager = new MemoryManager()
    const checkpoint = new CheckpointProvider()
    const fts = new FTSMemoryProvider()
    this.defaultProviders = [new BuiltinMemoryProvider(), checkpoint]
    if (workspace) {
      this.defaultProviders.push(new FileMemoryProvider(), fts)
    }
    for (const p of this.defaultProviders) manager.addProvider(p)
    checkpoint.setFTSProvider(fts)
    this.manager = manager
    await manager.initialize(sessionID, workspace)
  }

  /** 插件注册自定义 Provider（可逆：返回 disposer） */
  registerProvider(provider: MemoryProvider): () => void {
    if (!this.manager) {
      this.manager = new MemoryManager()
    }
    this.manager.addProvider(provider)
    return () => {
      this.manager?.removeProvider(provider.name)
    }
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
    this.defaultProviders = []
  }

  /** Agent 构造共享同一 MemoryManager（消除双实例） */
  getManager(): MemoryManager | null {
    return this.manager
  }
}