/**
 * 动态记忆图谱服务 — ctx.dynamicMemory
 * Mira 特色：艾宾浩斯衰减 + 激活传播 + 中文分词 + 本地 ONNX 嵌入
 */

import { Service } from "../vendor/cordis/index"
import { DynamicMemoryManager } from "../memory/dynamic-memory"
import type { MemoryNode } from "../memory/memory-node"
import type { DynamicMemoryService } from "../framework/context"

export class MiraDynamicMemoryService extends Service implements DynamicMemoryService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "dynamicMemory"
  private manager: DynamicMemoryManager | null = null

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "dynamicMemory")
  }

  /** 创建实例（懒初始化：数据库连接在首次节点操作时建立） */
  async initialize(_workspace: string): Promise<void> {
    if (!this.manager) this.manager = new DynamicMemoryManager()
  }

  async addNode(content: string, type: string): Promise<MemoryNode> {
    if (!this.manager) throw new Error("dynamicMemory 未初始化，请先调用 initialize")
    return this.manager.addNode(content, type as MemoryNode["type"])
  }

  async query(text: string, limit?: number): Promise<MemoryNode[]> {
    if (!this.manager) throw new Error("dynamicMemory 未初始化，请先调用 initialize")
    const result = await this.manager.activate(text)
    return (limit ? result.nodes.slice(0, limit) : result.nodes)
  }

  async activate(text: string): Promise<{ nodes: MemoryNode[] }> {
    if (!this.manager) throw new Error("dynamicMemory 未初始化，请先调用 initialize")
    return this.manager.activate(text)
  }

  async performDecay(): Promise<number> {
    if (!this.manager) return 0
    return this.manager.performDecay()
  }
}
