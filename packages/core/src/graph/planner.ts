/**
 * Planner 层 — 图定义生成（三层分离之一）
 * Planner 负责"怎么走"：根据输入状态与上下文，产出一份可执行的 GraphDefinition。
 * 模板（如 coding-task）本质就是 Planner 的具象化——将业务需求翻译为图结构。
 *
 * 约定：
 *   - create() 必须返回结构与状态 schema 自洽的图定义（节点白名单、出边合法性由 Runtime 二次校验）
 *   - Planner 不应执行任何节点，只做结构编排
 */

import type { GraphDefinition, GraphState } from "./types"

/** Planner 接口：输入状态 → 图定义 */
export interface Planner<S extends GraphState = GraphState, T = unknown> {
  /** 生成图定义 */
  create(state: S, options?: T): GraphDefinition<S>
  /** 图标识 */
  readonly graphId: string
}

/** 函数式 Planner 便捷构造 */
export function createPlanner<S extends GraphState = GraphState, T = unknown>(
  graphId: string,
  factory: (state: S, options?: T) => GraphDefinition<S>,
): Planner<S, T> {
  return { graphId, create: factory }
}

/** 在 Planner 链上追加后处理（组合多个规划器/装饰） */
export function composePlanner<S extends GraphState = GraphState, T = unknown>(
  planner: Planner<S, T>,
  decorate: (def: GraphDefinition<S>, state: S, options?: T) => GraphDefinition<S>,
): Planner<S, T> {
  return {
    graphId: planner.graphId,
    create: (state, options) => decorate(planner.create(state, options), state, options),
  }
}
