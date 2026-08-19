/**
 * 子 Agent 服务 — ctx.subagent
 * 持有 SubagentManager 实例（registry 经 tools 服务解析，sidecar/api.ts 共享单一寻址）。
 */

import { Service } from "../vendor/cordis/index"
import { SubagentManager } from "../orchestrate/subagent"
import type { SubagentInfo, SubagentEvent } from "../orchestrate/subagent"
import type { AgentConfig } from "../agent/constants"
import type { AgentEvent } from "../types"
import type { MiraToolService } from "./tools"
import type { SubagentService } from "../framework/context"

export class MiraSubagentService extends Service implements SubagentService {
  static provide = "subagent"
  static inject = ["tools"]

  private manager: SubagentManager

  constructor(ctx: import("../vendor/cordis/index").Context, config?: { manager?: SubagentManager; maxParallel?: number }) {
    super(ctx, "subagent")
    if (config?.manager) {
      this.manager = config.manager
    } else {
      const registry = (this.ctx.get("tools") as MiraToolService | undefined)?.registry
      if (!registry) throw new Error("ctx.subagent 需要 tools 服务（提供 ToolRegistry）")
      this.manager = new SubagentManager(registry, { maxParallel: config?.maxParallel })
    }
    this.manager.setCordisContext(ctx)
  }

  spawn(
    description: string,
    config: AgentConfig,
    options?: { parentId?: string; prompt?: string; model?: string; context?: "none" | "state" | "full"; mode?: "subagent" | "peer" },
  ): SubagentInfo {
    return this.manager.spawn(description, config, {
      parentId: options?.parentId,
      prompt: options?.prompt,
      model: options?.model,
      context: options?.context,
      mode: options?.mode,
    })
  }

  wait(id: string, timeoutMs?: number): Promise<SubagentInfo> {
    return this.manager.wait(id, timeoutMs)
  }

  cancel(id: string): boolean {
    return this.manager.cancel(id)
  }

  getInfo(id: string): SubagentInfo | null {
    return this.manager.getInfo(id)
  }

  getEvents(id: string): AgentEvent[] {
    return this.manager.getEvents(id)
  }

  list(filter?: { parentId?: string; status?: import("../orchestrate/subagent").SubagentStatus }): SubagentInfo[] {
    return this.manager.list(filter)
  }

  listActive(): SubagentInfo[] {
    return this.manager.listActive()
  }

  listByParent(parentId: string): SubagentInfo[] {
    return this.manager.listByParent(parentId)
  }

  cancelAllByParent(parentId: string): void {
    this.manager.cancelAllByParent(parentId)
  }

  cancelAll(): void {
    this.manager.cancelAll()
  }

  onEvent(callback: (event: SubagentEvent) => void): void {
    this.manager.onEvent(callback)
  }

  toText(): string {
    return this.manager.toText()
  }

  getManager(): SubagentManager {
    return this.manager
  }
}