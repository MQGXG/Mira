/**
 * Graph Engineering — 核心类型定义
 * 三概念：Node（能力单元）/ Edge（决策逻辑）/ State（带 Schema 的共享状态）
 */

/** 节点种类：能力单元的分类 */
export type GraphNodeKind = "agent" | "subagent" | "judge" | "function" | "human" | "workflow"

/** 共享状态更新策略 */
export type StateUpdateStrategy = "replace" | "append" | "reducer"

/** 状态字段 Schema 声明 */
export interface StateFieldSchema {
  type: "string" | "number" | "boolean" | "object" | "array"
  update?: StateUpdateStrategy
  required?: boolean
  /** reducer 模式下的合并函数名（由 StateStore 注册） */
  reducer?: string
}

/** 状态 Schema：声明字段类型 + 更新策略 */
export type GraphStateSchema = Record<string, StateFieldSchema>

/** 共享图状态（普通对象，字段受 Schema 约束） */
export type GraphState = Record<string, unknown>

/** 节点执行上下文 */
export interface GraphNodeContext<S extends GraphState = GraphState> {
  graphId: string
  runId: string
  nodeId: string
  state: Readonly<S>
  /** 追加子事件（供上层 AgentEvent 流式转发） */
  emit: (event: unknown) => void
  /** 全局 Token 预算累计 */
  tokenBudget: { used: number; limit: number }
}

/** 节点契约输出规格：运行后校验字段存在性与类型 */
export interface GraphNodeOutputSpec {
  field: string
  type?: StateFieldSchema["type"]
  required?: boolean
}

/** 节点契约：声明输入 + 输出，运行后由引擎校验（防"假装完成"） */
export interface GraphNodeContract {
  /** 声明读取的输入字段（文档/校验用途） */
  inputs?: string[]
  /** 声明必须产出的输出字段，运行后逐一校验 */
  outputs?: GraphNodeOutputSpec[]
}

/** 并行组：fan-out 多分支独立执行，在 join 节点汇聚 */
export interface GraphParallelGroup {
  /** 并行组 id（fan-out 节点，执行完该节点后触发并行） */
  id: string
  /** 分支入口节点（各自独立串行链，可含条件路由） */
  branches: string[]
  /** 汇聚节点（模式满足后从该节点继续执行） */
  join: string
  /** all_of：全部分支完成才放行；any_of：任一分支成功即放行 */
  mode: "all_of" | "any_of"
}

/** 恢复策略：失败路径升级决策（三层分离中的 Recovery 层） */
export interface RecoveryPolicy {
  /** 单节点最大重入次数（防死循环），超限触发升级 */
  maxReentries?: Record<string, number>
  /** 超限后行为：fail 终止 / escalate 走失败回退边 */
  onExhausted?: "fail" | "escalate"
  /** 全局最大节点执行次数（防总循环） */
  maxTotalExecutions?: number
}

/** 节点执行结果：状态补丁 + 可选 next_node 路由 */
export interface GraphNodeResult<S extends GraphState = GraphState> {
  patch?: Partial<S>
  /** next_node 模式：由节点主动指定下一节点，运行时校验白名单 */
  next_node?: string
  /** 节点输出文本（用于事件转发） */
  output?: string
  /** 节点级 token 用量 */
  usage?: { totalTokens?: number }
}

/** 锚点规则：模型不能编的事实，由外部系统验证（防跑偏设计） */
export interface AnchorRule {
  field: string
  /** 外部验证器：返回 true 表示锚点成立 */
  validate: (value: unknown) => boolean | Promise<boolean>
  message?: string
}

/** 图节点定义 */
export interface GraphNode<S extends GraphState = GraphState> {
  id: string
  kind: GraphNodeKind
  name: string
  run: (ctx: GraphNodeContext<S>) => Promise<GraphNodeResult<S>> | GraphNodeResult<S>
  /** 可读字段白名单 */
  reads?: (keyof S)[]
  /** 可写字段白名单 — 防 State 污染（越权写入被拒绝） */
  writes?: (keyof S)[]
  /** 节点级 Token 预算 */
  maxTokens?: number
  /** Frozen Node：输出不可被优化器修改 */
  frozen?: boolean
  /** 锚点校验：节点输出必须满足 */
  anchors?: AnchorRule[]
  /** 契约校验：运行后校验声明输出字段（防"假装完成"） */
  contract?: GraphNodeContract
  /** 超时（毫秒） */
  timeoutMs?: number
}

/** 条件路由分支 */
export interface GraphConditionBranch<S extends GraphState = GraphState> {
  if: (state: S) => boolean
  then: string
}

/** 边定义 */
export interface GraphEdge<S extends GraphState = GraphState> {
  from: string
  /** 目标：固定节点 / 函数路由 / 条件分支数组 */
  to: string | ((state: S) => string) | GraphConditionBranch<S>[]
  /** 成功还是失败时走此边 */
  on?: "success" | "failure" | "always"
  /** 失败回退重试上限 */
  maxRetries?: number
  /** 回退目标（on=failure 时，重试耗尽后跳转的节点） */
  fallback?: string
}

/** 图定义 */
export interface GraphDefinition<S extends GraphState = GraphState> {
  id: string
  name: string
  nodes: GraphNode<S>[]
  edges: GraphEdge<S>[]
  schema?: GraphStateSchema
  start: string
  /** 终止节点集合 */
  end: string[]
  /** 全局 Token 预算 */
  maxTotalTokens?: number
  /** 并行组（fan-out → join 汇聚） */
  parallels?: GraphParallelGroup[]
  /** 恢复策略（失败升级决策） */
  recovery?: RecoveryPolicy
}

/** 运行结果 */
export interface GraphRunResult<S extends GraphState = GraphState> {
  graphId: string
  runId: string
  status: "completed" | "interrupted" | "failed" | "budget_exceeded"
  state: S
  visited: string[]
  /** 事件轨迹（重放 trace 用） */
  events: unknown[]
  error?: string
  totalTokens: number
}

/** 持久化检查点 */
export interface GraphCheckpoint {
  graphId: string
  runId: string
  completedNodes: string[]
  state: Record<string, unknown>
  visited: string[]
  totalTokens: number
  updatedAt: string
}
