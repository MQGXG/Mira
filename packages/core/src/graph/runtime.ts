/**
 * StateGraph 运行时 — Graph Engineering 核心引擎
 * 特性：
 * 1. next_node 路由（节点主动指定下一节点，运行时校验出边白名单）
 * 2. 确定性优先的条件边（函数判断，不依赖 LLM 猜路由）
 * 3. 失败边回退重试（on="failure" + maxRetries + fallback）
 * 4. 每节点 checkpoint，中断可从最后完成的节点恢复
 * 5. 全局 Token 预算闸门
 * 6. Frozen Node 输出不可被修改
 * 7. 并行组（all_of / any_of fan-out → join 汇聚）
 * 8. 节点契约校验（contract：运行后校验声明输出字段）
 * 9. 迭代收敛（Recovery 层：单节点重入上限 + 失败升级）
 */

import { randomUUID } from "crypto"
import type {
  GraphDefinition,
  GraphState,
  GraphNodeContext,
  GraphRunResult,
  GraphCheckpoint,
  GraphParallelGroup,
  GraphStateSchema,
} from "./types"
import { StateStore } from "./state"
import { GraphPersist } from "./persist"
import { Recovery } from "./recovery"

export interface GraphRunOptions<S extends GraphState = GraphState> {
  initialState?: Partial<S>
  /** 恢复指定 run 的检查点继续执行 */
  resumeRunId?: string
  /** 恢复后从该节点续跑（默认：检查点最后完成节点的下一节点） */
  resumeFrom?: string
  signal?: AbortSignal
  onEvent?: (event: unknown) => void
  /** 覆盖全局预算 */
  maxTotalTokens?: number
  /** 指定运行 ID（用于外部事件频道区分） */
  runId?: string
}

export class StateGraph<S extends GraphState = GraphState> {
  private nodes = new Map<string, GraphDefinition<S>["nodes"][number]>()
  private edges: GraphDefinition<S>["edges"] = []
  private schema: GraphStateSchema
  private start: string
  private end: Set<string>
  private maxTotalTokens: number
  private parallels: GraphParallelGroup[] = []
  private recovery: Recovery
  private persist = new GraphPersist()

  constructor(private def: GraphDefinition<S>) {
    for (const node of def.nodes) this.nodes.set(node.id, node)
    this.edges = def.edges
    this.schema = def.schema || {}
    this.start = def.start
    this.end = new Set(def.end)
    this.maxTotalTokens = def.maxTotalTokens || 0
    this.parallels = def.parallels || []
    this.recovery = new Recovery(def.recovery)
  }

  /** 节点 id 集合 */
  get nodeIds(): string[] { return [...this.nodes.keys()] }

  /** 从某节点出发的全部出边目标（next_node 白名单） */
  private allowedTargets(nodeId: string): Set<string> {
    const targets = new Set<string>()
    for (const edge of this.edges) {
      if (edge.from !== nodeId) continue
      if (typeof edge.to === "string") targets.add(edge.to)
    }
    return targets
  }

  /** 解析边，返回目标节点（确定性优先，条件分支从左到右短路） */
  private resolveEdge(edge: { to: GraphDefinition<S>["edges"][number]["to"] }, state: S): string | null {
    if (typeof edge.to === "string") return edge.to
    if (typeof edge.to === "function") return edge.to(state)
    // 条件分支数组
    for (const branch of edge.to) {
      if (branch.if(state)) return branch.then
    }
    return null
  }

  /** 执行一次图运行（含恢复） */
  async run(options: GraphRunOptions<S> = {}): Promise<GraphRunResult<S>> {
    const runId = options.runId || `graph-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    const events: unknown[] = []
    const emit = (event: unknown): void => {
      events.push(event)
      options.onEvent?.(event)
    }

    // 恢复检查点
    let completedNodes: string[] = []
    let stateStore = new StateStore<S>(options.initialState as S, this.schema)
    let totalTokens = 0
    let resumeNodeId = this.start

    if (options.resumeRunId) {
      const cp = this.persist.loadCheckpoint(this.def.id, options.resumeRunId)
      if (cp) {
        stateStore = StateStore.fromJSON(cp.state as S)
        completedNodes = [...cp.completedNodes]
        totalTokens = cp.totalTokens || 0
        const lastNode = cp.completedNodes[cp.completedNodes.length - 1]
        // 检查点已完成全部 → 直接返回完成态
        if (lastNode && this.end.has(lastNode)) {
          return {
            graphId: this.def.id, runId, status: "completed",
            state: stateStore.get(), visited: [...cp.completedNodes], events, totalTokens,
          }
        }
        resumeNodeId = options.resumeFrom
          || this.nextNodeAfter(lastNode, stateStore.get())
          || this.start
      }
    }

    const budgetLimit = options.maxTotalTokens || this.maxTotalTokens || 0
    let currentNode: string | null = resumeNodeId
    const visited = [...completedNodes]

    while (currentNode) {
      if (options.signal?.aborted) {
        emit({ type: "graph_interrupted", nodeId: currentNode })
        return {
          graphId: this.def.id, runId, status: "interrupted",
          state: stateStore.get(), visited, events, totalTokens,
        }
      }

      // 预算闸门
      if (budgetLimit > 0 && totalTokens >= budgetLimit) {
        emit({ type: "graph_budget_exceeded", totalTokens })
        return {
          graphId: this.def.id, runId, status: "budget_exceeded",
          state: stateStore.get(), visited, events, totalTokens, error: "Budget exceeded",
        }
      }

      // 迭代收敛（Recovery 层）：单节点重入上限检查
      const reentry = this.recovery.beforeNode(currentNode)
      if (!reentry.allowed) {
        const msg = `[Graph] Iteration exhausted: ${reentry.reason}`
        emit({ type: "graph_iteration_exhausted", nodeId: currentNode, reason: reentry.reason })
        // escalate：走失败回退边
        if (this.recovery.escalate(currentNode) === "escalate") {
          const fallbackEdge = this.edges.find((e) => e.from === currentNode && e.fallback)
          if (fallbackEdge?.fallback) {
            emit({ type: "graph_escalate", nodeId: currentNode, to: fallbackEdge.fallback, reason: reentry.reason })
            currentNode = fallbackEdge.fallback
            continue
          }
        }
        return {
          graphId: this.def.id, runId, status: "failed",
          state: stateStore.get(), visited, events, totalTokens, error: msg,
        }
      }

      const node = this.nodes.get(currentNode)
      if (!node) {
        emit({ type: "graph_error", nodeId: currentNode, error: `Unknown node "${currentNode}"` })
        return {
          graphId: this.def.id, runId, status: "failed",
          state: stateStore.get(), visited, events, totalTokens,
          error: `Unknown node "${currentNode}"`,
        }
      }

      // 执行节点（含失败重试边）
      const { next, fallbackTo, patch, output, usage } = await this.executeNodeWithRetry(
        node, stateStore, runId, currentNode, emit,
      )

      totalTokens += usage?.totalTokens || 0
      visited.push(currentNode)
      completedNodes.push(currentNode)

      // 锚点校验（Frozen Node 输出保护）
      if (node.anchors) {
        for (const anchor of node.anchors) {
          const ok = await anchor.validate(patch?.[anchor.field as keyof S])
          if (!ok) {
            const msg = `[Graph] Anchor failed on node ${node.id}: ${anchor.message || `field ${anchor.field} unverifiable`}`
            emit({ type: "graph_anchor_failed", nodeId: node.id, error: msg })
            return {
              graphId: this.def.id, runId, status: "failed",
              state: stateStore.get(), visited, events, totalTokens, error: msg,
            }
          }
        }
      }

      // 写回状态（白名单约束）
      if (patch) stateStore.write(patch, node.writes)

      // 节点契约校验（运行后校验声明输出字段）
      const contractError = this.validateContract(node, stateStore, patch)
      if (contractError) {
        emit({ type: "graph_contract_failed", nodeId: node.id, error: contractError })
        return {
          graphId: this.def.id, runId, status: "failed",
          state: stateStore.get(), visited, events, totalTokens, error: contractError,
        }
      }

      // 并行组调度：当前节点是 fan-out 起点 → 并行执行分支并在 join 汇聚
      const parallelGroup = this.parallels.find((p) => p.id === currentNode)
      if (parallelGroup) {
        const { success, patches, usage, branchVisited, errors } = await this.executeParallel(
          parallelGroup, stateStore, runId, emit,
        )
        totalTokens += usage
        visited.push(...branchVisited)
        if (!success) {
          const msg = `[Graph] Parallel group "${parallelGroup.id}" failed (${parallelGroup.mode}): ${errors.join("; ")}`
          emit({ type: "graph_parallel_failed", group: parallelGroup.id, error: msg })
          return {
            graphId: this.def.id, runId, status: "failed",
            state: stateStore.get(), visited, events, totalTokens, error: msg,
          }
        }
        for (const p of patches) stateStore.merge(p)
        emit({ type: "graph_join", group: parallelGroup.id, mode: parallelGroup.mode, join: parallelGroup.join })
        currentNode = parallelGroup.join
        continue
      }

      // 失败回退（确定性配置，不校验 LLM 白名单）
      if (fallbackTo) {
        currentNode = fallbackTo
        continue
      }

      // 终止节点：执行完后结束
      if (this.end.has(currentNode)) {
        this.persist.saveCheckpoint({
          graphId: this.def.id, runId, completedNodes,
          state: stateStore.toJSON(), visited, totalTokens,
          updatedAt: new Date().toISOString(),
        })
        emit({ type: "graph_finish", nodeId: currentNode })
        return {
          graphId: this.def.id, runId, status: "completed",
          state: stateStore.get(), visited, events, totalTokens,
        }
      }

      // next_node 路由校验
      if (next) {
        const allowed = this.allowedTargets(currentNode)
        if (!allowed.has(next)) {
          const msg = `[Graph] Node ${currentNode} requested next_node "${next}" not in allowed targets`
          emit({ type: "graph_route_blocked", nodeId: currentNode, error: msg })
          return {
            graphId: this.def.id, runId, status: "failed",
            state: stateStore.get(), visited, events, totalTokens, error: msg,
          }
        }
        currentNode = next
        continue
      }

      // 按边路由
      let nextNode: string | null = null
      for (const edge of this.edges) {
        if (edge.from !== currentNode) continue
        const resolved = this.resolveEdge(edge, stateStore.get())
        if (resolved && (edge.on === "success" || edge.on === "always" || !edge.on)) {
          nextNode = resolved
          break
        }
      }

      // 检查点落盘
      this.persist.saveCheckpoint({
        graphId: this.def.id, runId, completedNodes,
        state: stateStore.toJSON(), visited, totalTokens,
        updatedAt: new Date().toISOString(),
      })

      emit({ type: "graph_node_complete", nodeId: currentNode, nextNode, output })
      currentNode = nextNode
    }

    return {
      graphId: this.def.id, runId, status: "failed",
      state: stateStore.get(), visited, events, totalTokens,
      error: "Graph ended without reaching an end node",
    }
  }

  /** 契约校验：节点运行后校验声明输出字段存在且类型正确 */
  private validateContract(
    node: GraphDefinition<S>["nodes"][number],
    stateStore: StateStore<S>,
    patch?: Partial<S>,
  ): string | null {
    if (!node.contract?.outputs?.length) return null
    for (const spec of node.contract.outputs) {
      const inPatch = patch && spec.field in patch
      // required：节点本轮必须产出该字段（防"假装完成"）
      if (spec.required && !inPatch) {
        return `[Graph] Node ${node.id} contract violated: required output "${spec.field}" missing`
      }
      // 类型校验：不依赖 schema（契约自带声明），显式类型判断
      if (inPatch && spec.type && !isTypeMatch(patch?.[spec.field as keyof S], spec.type)) {
        return `[Graph] Node ${node.id} contract violated: "${spec.field}" expected ${spec.type}`
      }
    }
    return null
  }

  /** 并行组执行：各分支独立状态视图并发跑，join 汇聚 */
  private async executeParallel(
    group: GraphParallelGroup,
    stateStore: StateStore<S>,
    runId: string,
    emit: (event: unknown) => void,
  ): Promise<{
    success: boolean
    patches: Partial<S>[]
    usage: number
    branchVisited: string[]
    errors: string[]
  }> {
    const base = stateStore.snapshot()
    const branchResults = await Promise.all(
      group.branches.map(async (entry) => {
        const branchStore = new StateStore<S>(base, this.schema)
        // 分支增量补丁：只记录本分支产生的变更（append 字段保留增量），最终 merge 回主 store
        const branchPatch: Partial<S> = {}
        const branchVisited: string[] = []
        const errors: string[] = []
        let usage = 0
        let cursor: string | null = entry

        while (cursor && cursor !== group.join) {
          const branchNode = this.nodes.get(cursor)
          if (!branchNode) {
            errors.push(`Unknown branch node "${cursor}"`)
            break
          }
          try {
            const { patch, usage: u, fallbackTo } = await this.executeNodeWithRetry(
              branchNode, branchStore, runId, cursor, emit,
            )
            usage += u?.totalTokens || 0
            branchVisited.push(cursor)
            if (patch) {
              // 视图合并（append 策略累积到 base 之上）
              branchStore.merge(patch)
              // 增量累积（相对 base 的变更，供 join 汇聚）
              this.accumulatePatch(branchPatch, patch)
            }
            if (fallbackTo) {
              cursor = fallbackTo
              continue
            }
            cursor = this.nextNodeAfter(cursor, branchStore.get()) || group.join
          } catch (err) {
            errors.push(String(err instanceof Error ? err.message : err))
            break
          }
        }

        return { errors, usage, visited: branchVisited, patch: branchPatch }
      }),
    )

    // all_of：全部分支成功；any_of：任一分支成功
    const okBranches = branchResults.filter((r) => r.errors.length === 0)
    const success = group.mode === "all_of"
      ? okBranches.length === branchResults.length
      : okBranches.length > 0

    const errors = branchResults.flatMap((r) => r.errors)
    return {
      success,
      patches: okBranches.map((r) => r.patch),
      usage: branchResults.reduce((sum, r) => sum + r.usage, 0),
      branchVisited: branchResults.flatMap((r) => r.visited),
      errors,
    }
  }

  /** 增量补丁累积（append 字段在增量上继续追加，replace 字段整体覆盖） */
  private accumulatePatch(acc: Partial<S>, patch: Partial<S>): void {
    for (const [key, value] of Object.entries(patch)) {
      const k = key as keyof S
      const fieldSchema = this.schema[key]
      const v = value as S[keyof S]
      if (fieldSchema?.update === "append") {
        const cur = acc[k]
        const incoming = Array.isArray(v) ? v : [v]
        acc[k] = (Array.isArray(cur) ? cur.concat(incoming as unknown[]) : incoming) as S[keyof S]
      } else {
        acc[k] = v
      }
    }
  }

  /** 执行节点 + 失败回退重试 */
  private async executeNodeWithRetry(
    node: GraphDefinition<S>["nodes"][number],
    stateStore: StateStore<S>,
    runId: string,
    nodeId: string,
    emit: (event: unknown) => void,
  ): Promise<{ next?: string; fallbackTo?: string; patch?: Partial<S>; output?: string; usage?: { totalTokens?: number } }> {
    const retryEdges = this.edges.filter((e) => e.from === nodeId && (e.on === "failure" || e.on === "always"))
    const maxRetries = retryEdges.reduce((max, e) => Math.max(max, e.maxRetries || 0), 0)

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctx: GraphNodeContext<S> = {
        graphId: this.def.id, runId, nodeId,
        state: stateStore.get(),
        emit,
        tokenBudget: { used: 0, limit: node.maxTokens || 0 },
      }

      try {
        const promises: Array<Promise<{ patch?: Partial<S>; next_node?: string; output?: string; usage?: { totalTokens?: number } }>> = [
          Promise.resolve(node.run(ctx)),
        ]
        if (node.timeoutMs) {
          promises.push(new Promise<{ patch?: Partial<S>; next_node?: string; output?: string; usage?: { totalTokens?: number } }>((_, reject) => {
            setTimeout(() => reject(new Error(`Node ${nodeId} timed out`)), node.timeoutMs)
          }))
        }
        const result = await Promise.race(promises)

        return {
          next: result.next_node,
          patch: result.patch,
          output: result.output,
          usage: result.usage,
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        if (attempt < maxRetries) {
          emit({ type: "graph_retry", nodeId, attempt: attempt + 1, error })
          continue
        }
        // 重试耗尽 → fallback 或终止
        const fallback = retryEdges.find((e) => e.fallback)?.fallback
        if (fallback) {
          emit({ type: "graph_fallback", nodeId, to: fallback, error })
          return { fallbackTo: fallback, usage: { totalTokens: 0 } }
        }
        const msg = `[Graph] Node ${nodeId} failed after ${maxRetries} retries: ${error}`
        emit({ type: "graph_error", nodeId, error: msg })
        throw new Error(msg)
      }
    }

    throw new Error(`[Graph] Node ${nodeId} unreachable`)
  }

  /** 返回某节点之后的路由目标（用于恢复续跑） */
  private nextNodeAfter(nodeId: string, state: S): string | null {
    if (!nodeId) return null
    for (const edge of this.edges) {
      if (edge.from !== nodeId) continue
      const resolved = this.resolveEdge(edge, state)
      if (resolved) return resolved
    }
    return null
  }

  /** 列出某图的历史运行（供 UI 展示/恢复） */
  listRuns(): GraphCheckpoint[] {
    return this.persist.listCheckpoints(this.def.id)
  }
}

/** 契约声明的显式类型判断（不依赖 schema） */
function isTypeMatch(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string"
    case "number": return typeof value === "number"
    case "boolean": return typeof value === "boolean"
    case "array": return Array.isArray(value)
    case "object": return typeof value === "object" && !Array.isArray(value) && value !== null
    default: return true
  }
}
