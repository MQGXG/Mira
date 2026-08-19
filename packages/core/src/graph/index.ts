/**
 * Graph Engineering — 统一导出
 * 提供通用图编排引擎 + 三层分离（Planner / Runtime / Recovery）+ 内置业务图模板
 */

export { StateGraph } from "./runtime"
export type { GraphRunOptions } from "./runtime"
export { StateStore } from "./state"
export { GraphPersist } from "./persist"
export { Recovery, mergeRecoveryPolicies } from "./recovery"
export type { RecoveryDecision } from "./recovery"
export { createPlanner, composePlanner } from "./planner"
export type { Planner } from "./planner"
export type {
  GraphDefinition,
  GraphNode,
  GraphEdge,
  GraphState,
  GraphStateSchema,
  GraphNodeKind,
  GraphNodeContext,
  GraphNodeResult,
  GraphRunResult,
  GraphCheckpoint,
  GraphConditionBranch,
  GraphParallelGroup,
  GraphNodeContract,
  GraphNodeOutputSpec,
  RecoveryPolicy,
  AnchorRule,
  StateUpdateStrategy,
} from "./types"

export { runCodingTask, buildCodingTaskGraph, createCodingTaskPlanner } from "./templates/coding-task"
export type { CodingTaskOptions, CodingState } from "./templates/coding-task"
