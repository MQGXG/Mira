/**
 * AgentInternals — Agent 循环阶段函数对 Agent 内部状态的依赖契约
 *
 * 拆分 agent.ts 的 5 阶段到独立文件时，阶段函数通过该接口访问 Agent 的内部
 * 状态（运行时经类型断言读取，Agent 私有字段编译后为普通属性，零运行时开销）。
 * 该接口集中列出"循环依赖面"，是后续循环插件化（AgentLoopImpl）的替换边界。
 */

import type { AgentStateMachine } from "./state-machine"
import type { MemoryManager } from "../memory/manager"
import type { DynamicMemoryManager } from "../memory/dynamic-memory"
import type { ApprovalStore } from "../system/permission/approval-store"
import type { ToolOrchestrator } from "../orchestrate/execution"
import type { CheckpointProvider } from "../memory/checkpoint-provider"
import type { DreamDistillManager } from "../orchestrate/dream"
import type { ContextManager } from "../session/context"
import type { GoalJudge } from "../orchestrate/goal-judge"
import type { Context as MiraContext } from "../vendor/cordis/index"
import type { SourceManager } from "../session/context-source"
import type { VectorMemoryProvider } from "../memory/vector-provider"
import type { TokenUsageAccumulator } from "../session/token-projection"
import type { ToolRegistry } from "../system/registry"

/** Agent 循环阶段访问的内部状态面 */
export interface AgentInternals {
  stateMachine: AgentStateMachine
  memoryManager: MemoryManager
  dynamicMemory: DynamicMemoryManager
  approvalStore: ApprovalStore
  orchestrator: ToolOrchestrator
  checkpointProvider: CheckpointProvider
  dreamDistillManager: DreamDistillManager
  contextManager: ContextManager
  goalJudge: GoalJudge
  miraCtx: MiraContext | null
  sourceManager: SourceManager | null
  sourceManagerSources: {
    memory: import("../session/context-source").MemorySource
    code: import("../session/context-source").CodeSource
    goal: import("../session/context-source").GoalSource
    mode: import("../session/context-source").ModeSource
    knowledge: import("../session/context-source").KnowledgeSource
  } | null
  _vectorProvider: VectorMemoryProvider | null
  ngramBuffer: string[]
  runTotalTokens: number
  consecutiveToolTurns: number
  graphBatchIds: string[]
  lastGraphMaintenanceAt: number
  tokenAccumulators: Map<string, TokenUsageAccumulator>
  registry: ToolRegistry
}

/** 类型断言：Agent 实例 → AgentInternals（运行时零开销） */
export function asInternals(agent: unknown): AgentInternals {
  return agent as unknown as AgentInternals
}
