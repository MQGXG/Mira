/**
 * Workflow 服务 — ctx.workflow
 * 持有 WorkflowEngine 实例（setEngine 可替换），消除 workflow-tool 模块级单例。
 */

import { Service } from "../vendor/cordis/index"
import { WorkflowEngine } from "../workflow/index"
import type { WorkflowDefinition, WorkflowRunOptions, WorkflowResult } from "../workflow/index"
import type { WorkflowService } from "../framework/context"

export class MiraWorkflowService extends Service implements WorkflowService {
  static provide = "workflow"

  private engine: WorkflowEngine

  constructor(ctx: import("../vendor/cordis/index").Context, config?: { engine?: WorkflowEngine }) {
    super(ctx, "workflow")
    this.engine = config?.engine ?? new WorkflowEngine()
  }

  execute(workflow: WorkflowDefinition, options?: WorkflowRunOptions): Promise<{ results: WorkflowResult[]; elapsedMs: number }> {
    return this.engine.execute(workflow, options)
  }

  cancel(runId: string): boolean {
    return this.engine.cancel(runId)
  }

  /** 插件替换引擎实现（自定义步骤类型/transform 注册表等） */
  setEngine(engine: unknown): void {
    this.engine = engine as WorkflowEngine
  }

  getEngine(): WorkflowEngine {
    return this.engine
  }
}