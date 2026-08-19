/**
 * Dream/Distill 服务 — ctx.dream
 * 持有 DreamDistillManager 实例（sidecar/Agent 构造共享，消除主进程双实例）。
 */

import { Service } from "../vendor/cordis/index"
import { DreamDistillManager } from "../orchestrate/dream"
import type { DreamResult, KnowledgeEntry, GraphStore, LLMConfig } from "../orchestrate/dream-types"
import type { LLMMessage } from "../llm/schema/messages"
import type { DreamService } from "../framework/context"

export class MiraDreamService extends Service implements DreamService {
  static provide = "dream"

  private manager: DreamDistillManager

  constructor(ctx: import("../vendor/cordis/index").Context, config?: { manager?: DreamDistillManager }) {
    super(ctx, "dream")
    this.manager = config?.manager ?? new DreamDistillManager()
  }

  initialize(workspace: string): Promise<void> {
    return this.manager.initialize(workspace)
  }

  setLLMConfig(config: LLMConfig): void {
    this.manager.setLLMConfig(config)
  }

  recordTurn(user: string, assistant: string): void {
    this.manager.recordTurn(user, assistant)
  }

  shouldAutoDream(): boolean {
    return this.manager.shouldAutoDream()
  }

  autoDream(): Promise<DreamResult | null> {
    return this.manager.autoDream()
  }

  runDream(history: LLMMessage[], config: LLMConfig): Promise<DreamResult> {
    return this.manager.runDream(history, config)
  }

  distill(history: LLMMessage[], config: LLMConfig): Promise<unknown> {
    return this.manager.distill(history, config)
  }

  getKnowledge(): KnowledgeEntry[] {
    return this.manager.getKnowledge()
  }

  knowledgeToText(): string {
    return this.manager.knowledgeToText()
  }

  toSystemPrompt(): string {
    return this.manager.toSystemPrompt()
  }

  toText(): string {
    return this.manager.toText()
  }

  getGraphData(): { entities: GraphStore["entities"]; relationships: GraphStore["relationships"] } {
    return this.manager.getGraphData()
  }

  getManager(): DreamDistillManager {
    return this.manager
  }
}