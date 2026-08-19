/**
 * 工具编排器 — 参考 Codex orchestrator.rs
 * 工具声明式并行 + Promise.allSettled 并发执行
 */

import type { ToolRegistry } from "../system/registry"
import type { ToolContext, ToolResult } from "../shared/tool"
import { executeToolCalls } from "../shared/tool-executor"
import { ToolOutputStore } from "../tools/shared/tool-output-store"
import { isToolParallel } from "../tools/shared/tool-meta"

export interface OrchestratedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export class ToolOrchestrator {
  private outputStore: ToolOutputStore

  constructor(
    private registry: ToolRegistry,
    options?: { persistDir?: string },
  ) {
    this.outputStore = new ToolOutputStore({ persistDir: options?.persistDir })
  }

  async execute(
    calls: OrchestratedToolCall[],
    ctx: ToolContext,
    extra?: { provider?: string; model?: string },
  ): Promise<Map<string, ToolResult>> {
    const results = new Map<string, ToolResult>()
    if (calls.length === 0) return results

    const groups = this.groupCalls(calls)

    for (const group of groups) {
      const groupResults = await this.executeGroup(group, ctx, extra)
      for (const [id, result] of groupResults) {
        results.set(id, result)
        if (result.output) {
          this.outputStore.store(id, group.find((c) => c.id === id)?.name || "", result.output)
        }
      }
    }

    return results
  }

  async *executeStreaming(
    calls: OrchestratedToolCall[],
    ctx: ToolContext,
    extra?: { provider?: string; model?: string },
  ): AsyncGenerator<{ id: string; result: ToolResult }> {
    if (calls.length === 0) return

    const groups = this.groupCalls(calls)

    for (const group of groups) {
      if (group.length === 1) {
        const result = await this.executeSingle(group[0], ctx, extra)
        for (const [id, r] of result) {
          if (r.output) this.outputStore.store(id, group[0]?.name || "", r.output)
          yield { id, result: r }
        }
      } else {
        const semaphore = 5
        for (let i = 0; i < group.length; i += semaphore) {
          const batch = group.slice(i, i + semaphore)
          const batchResults = await Promise.all(
            batch.map(async (call) => {
              const result = await this.executeSingle(call, ctx, extra)
              for (const [id, r] of result) {
                if (r.output) this.outputStore.store(id, call.name, r.output)
                return { id, result: r }
              }
              return { id: call.id, result: { success: false, error: "No result" } }
            }),
          )
          for (const item of batchResults) {
            yield item
          }
        }
      }
    }
  }

  /**
   * 将工具调用分组：
   * - 声明了 supportsParallel 的工具合并为一组并行执行
   * - 非并行工具各自独占一组串行执行
   */
  private groupCalls(calls: OrchestratedToolCall[]): OrchestratedToolCall[][] {
    const groups: OrchestratedToolCall[][] = []
    let parallelGroup: OrchestratedToolCall[] = []

    for (const call of calls) {
      if (isToolParallel(call.name)) {
        parallelGroup.push(call)
      } else {
        if (parallelGroup.length > 0) {
          groups.push(parallelGroup)
          parallelGroup = []
        }
        groups.push([call])
      }
    }

    if (parallelGroup.length > 0) {
      groups.push(parallelGroup)
    }

    return groups
  }

  private async executeGroup(
    calls: OrchestratedToolCall[],
    ctx: ToolContext,
    extra?: { provider?: string; model?: string },
  ): Promise<Map<string, ToolResult>> {
    if (calls.length === 1) {
      const result = await this.executeSingle(calls[0], ctx, extra)
      return result
    }

    // 并行执行：使用 Promise.allSettled × 信号量控制并发数
    const semaphore = 5  // 最大并发数
    const results = new Map<string, ToolResult>()
    const executing: Promise<void>[] = []

    for (let i = 0; i < calls.length; i += semaphore) {
      const batch = calls.slice(i, i + semaphore)
      const batchResults = await Promise.allSettled(
        batch.map((call) => this.executeSingle(call, ctx, extra))
      )

      for (let j = 0; j < batch.length; j++) {
        const settled = batchResults[j]
        if (settled.status === "fulfilled") {
          for (const [id, r] of settled.value) {
            results.set(id, r)
          }
        } else {
          results.set(batch[j].id, {
            success: false,
            error: settled.reason?.message || "Execution failed",
          })
        }
      }
    }

    return results
  }

  private async executeSingle(
    call: OrchestratedToolCall,
    ctx: ToolContext,
    extra?: { provider?: string; model?: string },
  ): Promise<Map<string, ToolResult>> {
    const formatted = [{
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }]
    return (await executeToolCalls(formatted, this.registry, ctx, extra)).results
  }
}
