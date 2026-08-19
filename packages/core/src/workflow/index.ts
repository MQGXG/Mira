import { randomUUID } from "crypto"
import { createLLMClient, type LLMMessage, type LLMToolSet } from "../llm/client"
import { logError } from "../system/logger"

export type WorkflowStepType = "agent" | "bash" | "parallel" | "pipeline" | "transform"

export interface WorkflowStep {
  id: string
  type: WorkflowStepType
  name: string
  description?: string
  /** agent 类型步骤：发给 LLM 的 prompt */
  prompt?: string
  /** bash 类型步骤：shell 命令 */
  command?: string
  /** agent 类型步骤：可用的工具集 */
  tools?: string[]
  /** 嵌套步骤（parallel/pipeline） */
  steps?: WorkflowStep[]
  /** 输入转换函数名（transform 类型） */
  transform?: string
  /** 依赖的上一步输出映射 */
  inputs?: Record<string, string>
  /** 超时（秒） */
  timeout?: number
  /** 最大重试次数 */
  retries?: number
}

export interface WorkflowResult {
  stepId: string
  stepName: string
  status: "success" | "failed" | "skipped" | "timeout"
  output: string
  elapsedMs: number
  error?: string
  children?: WorkflowResult[]
}

export interface WorkflowDefinition {
  name: string
  description: string
  version?: string
  steps: WorkflowStep[]
  /** 全局超时（秒） */
  timeout?: number
  /** 全局最大重试 */
  retries?: number
}

export interface WorkflowRunOptions {
  llmConfig?: {
    provider: string
    model: string
    apiKey: string
    apiUrl?: string
  }
  variables?: Record<string, string>
  signal?: AbortSignal
  onStepComplete?: (result: WorkflowResult) => void
}

export class WorkflowEngine {
  private running = new Map<string, AbortController>()

  async execute(
    workflow: WorkflowDefinition,
    options: WorkflowRunOptions = {},
  ): Promise<{ results: WorkflowResult[]; elapsedMs: number }> {
    const runId = `wf-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
    const abortController = new AbortController()
    this.running.set(runId, abortController)

    const signal = options.signal || abortController.signal
    const startTime = Date.now()

    try {
      const results = await this.executeSteps(workflow.steps, options, signal)
      return { results, elapsedMs: Date.now() - startTime }
    } finally {
      this.running.delete(runId)
    }
  }

  cancel(runId: string): boolean {
    const controller = this.running.get(runId)
    if (!controller) return false
    controller.abort()
    return true
  }

  private async executeSteps(
    steps: WorkflowStep[],
    options: WorkflowRunOptions,
    signal: AbortSignal,
  ): Promise<WorkflowResult[]> {
    const results: WorkflowResult[] = []

    for (const step of steps) {
      if (signal.aborted) {
        results.push({
          stepId: step.id, stepName: step.name, status: "skipped",
          output: "Workflow cancelled", elapsedMs: 0,
        })
        break
      }

      const result = await this.executeStep(step, options, signal)
      results.push(result)
      options.onStepComplete?.(result)

      if (result.status === "failed") break
    }

    return results
  }

  private async executeStep(
    step: WorkflowStep,
    options: WorkflowRunOptions,
    signal: AbortSignal,
  ): Promise<WorkflowResult> {
    const startTime = Date.now()
    const maxRetries = step.retries ?? options.llmConfig ? 2 : 0

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }

      try {
        switch (step.type) {
          case "agent":
            return await this.executeAgentStep(step, options, signal, startTime)
          case "bash":
            return await this.executeBashStep(step, options, signal, startTime)
          case "parallel":
            return await this.executeParallelStep(step, options, signal, startTime)
          case "pipeline":
            return await this.executePipelineStep(step, options, signal, startTime)
          case "transform":
            return this.executeTransformStep(step, options, startTime)
          default:
            return {
              stepId: step.id, stepName: step.name, status: "failed",
              output: "", elapsedMs: Date.now() - startTime,
              error: `Unknown step type: ${step.type}`,
            }
        }
      } catch (err) {
        if (attempt < maxRetries) continue
        return {
          stepId: step.id, stepName: step.name, status: "failed",
          output: "", elapsedMs: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    return {
      stepId: step.id, stepName: step.name, status: "failed",
      output: "", elapsedMs: Date.now() - startTime,
      error: "Max retries exceeded",
    }
  }

  private async executeAgentStep(
    step: WorkflowStep,
    options: WorkflowRunOptions,
    signal: AbortSignal,
    startTime: number,
  ): Promise<WorkflowResult> {
    if (!options.llmConfig) {
      return { stepId: step.id, stepName: step.name, status: "failed", output: "", elapsedMs: Date.now() - startTime, error: "No LLM config for agent step" }
    }

    const prompt = step.prompt || step.description || "Execute this workflow step"
    const messages: LLMMessage[] = [{ role: "user", content: prompt }]

    const client = createLLMClient({
      provider: options.llmConfig.provider,
      model: options.llmConfig.model,
      apiKey: options.llmConfig.apiKey,
      apiUrl: options.llmConfig.apiUrl,
    })

    let response = ""

    try {
      for await (const event of client.stream({ messages, tools: {} })) {
        if (event.type === "delta") response += event.delta
        if (event.type === "error") throw new Error(event.error.message)
        if (event.type === "done") break
      }
    } catch (err) {
      return {
        stepId: step.id, stepName: step.name, status: "failed",
        output: response, elapsedMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    return {
      stepId: step.id, stepName: step.name, status: "success",
      output: response, elapsedMs: Date.now() - startTime,
    }
  }

  private async executeBashStep(
    step: WorkflowStep,
    _options: WorkflowRunOptions,
    signal: AbortSignal,
    startTime: number,
  ): Promise<WorkflowResult> {
    if (!step.command) {
      return { stepId: step.id, stepName: step.name, status: "failed", output: "", elapsedMs: Date.now() - startTime, error: "No command for bash step" }
    }

    try {
      const { execSync } = await import("child_process")
      const output = execSync(step.command, {
        encoding: "utf-8",
        timeout: (step.timeout || 30) * 1000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })

      return {
        stepId: step.id, stepName: step.name, status: "success",
        output: output.trim(), elapsedMs: Date.now() - startTime,
      }
    } catch (err: any) {
      return {
        stepId: step.id, stepName: step.name, status: "failed",
        output: err.stdout || "", elapsedMs: Date.now() - startTime,
        error: err.stderr || err.message || String(err),
      }
    }
  }

  private async executeParallelStep(
    step: WorkflowStep,
    options: WorkflowRunOptions,
    signal: AbortSignal,
    startTime: number,
  ): Promise<WorkflowResult> {
    if (!step.steps || step.steps.length === 0) {
      return { stepId: step.id, stepName: step.name, status: "success", output: "(no steps)", elapsedMs: Date.now() - startTime }
    }

    const results = await Promise.all(
      step.steps.map((s) => this.executeStep(s, options, signal)),
    )

    const allSuccess = results.every((r) => r.status === "success")
    return {
      stepId: step.id, stepName: step.name,
      status: allSuccess ? "success" : "failed",
      output: results.map((r) => `[${r.stepName}] ${r.output.slice(0, 200)}`).join("\n"),
      elapsedMs: Date.now() - startTime,
      children: results,
    }
  }

  private async executePipelineStep(
    step: WorkflowStep,
    options: WorkflowRunOptions,
    signal: AbortSignal,
    startTime: number,
  ): Promise<WorkflowResult> {
    if (!step.steps || step.steps.length === 0) {
      return { stepId: step.id, stepName: step.name, status: "success", output: "(no steps)", elapsedMs: Date.now() - startTime }
    }

    const results = await this.executeSteps(step.steps, options, signal)
    const allSuccess = results.every((r) => r.status === "success")

    return {
      stepId: step.id, stepName: step.name,
      status: allSuccess ? "success" : "failed",
      output: results.map((r) => `[${r.stepName}] ${r.output.slice(0, 200)}`).join("\n"),
      elapsedMs: Date.now() - startTime,
      children: results,
    }
  }

  private executeTransformStep(
    step: WorkflowStep,
    _options: WorkflowRunOptions,
    startTime: number,
  ): WorkflowResult {
    const builtinTransforms: Record<string, (input: Record<string, string>) => string> = {
      uppercase: (input) => Object.values(input).join(" ").toUpperCase(),
      lowercase: (input) => Object.values(input).join(" ").toLowerCase(),
      join: (input) => Object.values(input).filter(Boolean).join("\n"),
      json_parse: (input) => {
        try {
          const parsed = JSON.parse(Object.values(input)[0] || "{}")
          return JSON.stringify(parsed, null, 2)
        } catch { return "Parse error" }
      },
    }

    const transformFn = step.transform ? builtinTransforms[step.transform] : null
    if (!transformFn) {
      return { stepId: step.id, stepName: step.name, status: "failed", output: "", elapsedMs: Date.now() - startTime, error: `Unknown transform: ${step.transform}` }
    }

    try {
      const output = transformFn(step.inputs || {})
      return { stepId: step.id, stepName: step.name, status: "success", output, elapsedMs: Date.now() - startTime }
    } catch (err) {
      return { stepId: step.id, stepName: step.name, status: "failed", output: "", elapsedMs: Date.now() - startTime, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

