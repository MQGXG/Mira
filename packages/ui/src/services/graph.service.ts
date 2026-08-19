/**
 * Graph Service — 图编排服务
 * 封装 electronAPI.graph 调用
 */

export interface GraphRunOptions {
  maxSteps?: number
  testCommand?: string
  maxTotalTokens?: number
}

export interface GraphCheckpoint {
  graphId: string
  runId: string
  completedNodes: string[]
  state: Record<string, unknown>
  visited: string[]
  totalTokens: number
  updatedAt: string
}

export interface GraphResult {
  type: "graph_result"
  runId: string
  status: string
  state: Record<string, unknown>
  visited: string[]
  totalTokens: number
  error?: string
}

export const GraphService = {
  /** 启动编码任务图 */
  runCodingTask: (request: string, config: Record<string, unknown>, options?: GraphRunOptions) =>
    window.electronAPI.graph.runCodingTask(request, config, options),

  /** 查询运行状态 */
  getStatus: (runId: string) => window.electronAPI.graph.getStatus(runId),

  /** 列出历史运行 */
  listRuns: (graphId?: string) => window.electronAPI.graph.listRuns(graphId),

  /** 停止运行 */
  stop: (runId: string) => window.electronAPI.graph.stop(runId),
}
