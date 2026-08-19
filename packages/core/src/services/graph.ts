/**
 * Graph 服务 — ctx.graph
 * coding-task 图运行 + 运行状态单一寻址（activeGraphRuns 从 system/server/api.ts 迁入）。
 */

import { Service } from "../vendor/cordis/index"
import { StateGraph } from "../graph/runtime"
import { GraphPersist } from "../graph/persist"
import { buildCodingTaskGraph } from "../graph/templates/coding-task"
import type { CodingState } from "../graph/templates/coding-task"
import type { GraphRunResult } from "../graph/types"
import type { AgentConfig } from "../agent/constants"
import type { MiraToolService } from "./tools"
import type { GraphService } from "../framework/context"

export class MiraGraphService extends Service implements GraphService {
  static provide = "graph"
  static inject = ["tools"]

  private activeRuns = new Map<string, { promise: Promise<GraphRunResult<CodingState>> }>()

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "graph")
  }

  runCodingTask(
    request: string,
    config: Record<string, unknown>,
    options: { maxSteps?: number; testCommand?: string; maxTotalTokens?: number },
    runId: string,
    onEvent?: (evt: unknown) => void,
    onFinish?: {
      onResult?(result: GraphRunResult<CodingState>): void
      onEnd?(): void
    },
  ): void {
    const registry = (this.ctx.get("tools") as MiraToolService | undefined)?.registry
    if (!registry) throw new Error("ctx.graph 需要 tools 服务（提供 ToolRegistry）")

    const graph = buildCodingTaskGraph(registry, config as unknown as AgentConfig, {
      request,
      maxSteps: options?.maxSteps,
      testCommand: options?.testCommand,
      collectEvents: true,
    })
    const engine = new StateGraph<CodingState>(graph)

    const promise = engine.run({
      runId,
      maxTotalTokens: options?.maxTotalTokens,
      initialState: {
        request,
        files: [],
        testOutput: "",
        testPassed: false,
        reviewVerdict: "pending",
        reviewFeedback: "",
        fixFeedback: "",
        iterations: 0,
        finalSummary: "",
        trace: [],
      },
      onEvent: onEvent as never,
    })

    this.activeRuns.set(runId, { promise })
    void promise
      .then((result) => {
        onFinish?.onResult?.(result)
      })
      .catch(() => {})
      .finally(() => {
        this.activeRuns.delete(runId)
        onFinish?.onEnd?.()
      })
  }

  getStatus(runId: string): { runId: string; active: boolean } {
    return { runId, active: this.activeRuns.has(runId) }
  }

  listRuns(graphId?: string): unknown[] {
    return new GraphPersist().listCheckpoints(graphId || "coding-task")
  }

  stop(runId: string): boolean {
    if (!this.activeRuns.has(runId)) return false
    this.activeRuns.delete(runId)
    return true
  }
}