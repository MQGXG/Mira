/**
 * 编码任务全流程 Graph 模板
 *
 * 节点：
 *   research  → implement → test → review → done
 *                 ↑           ↓        ↓
 *                 └───── fix ←┘        └→ fix（驳回时带反馈）
 *
 * 边均为确定性：
 *   - test：bash 退出码决定 通过/失败
 *   - review：judge 节点 JSON verdict 决定 批准/驳回
 *
 * research / implement / fix 节点真实驱动 Agent.run()（含工具循环），
 * 每个节点内部就是一个完整 Loop —— 对应 Graph 工程"节点内部跑 Loop"。
 */

import type { GraphDefinition, GraphState, GraphNode } from "../types"
import type { AgentConfig } from "../../agent/constants"
import { executeToolCalls } from "../../shared/tool-executor"
import type { ToolRegistry } from "../../system/registry"
import { buildToolContext } from "../../agent/context"
import { logError } from "../../system/logger"
import { runAgentNode } from "../nodes/agent-runner"
import { createPlanner } from "../planner"
import type { Planner } from "../planner"

export interface CodingTaskOptions {
  /** 用户请求原文 */
  request: string
  /** 节点内 Agent 的最大步数 */
  maxSteps?: number
  /** 测试命令（默认 pnpm typecheck 探测，可覆盖） */
  testCommand?: string
  /** 是否收集 Agent 事件轨迹（供 UI 展示） */
  collectEvents?: boolean
}

/** 编码任务图状态（模板内部状态，供运行时/IPC 消费） */
export interface CodingState extends GraphState {
  request: string
  files: string[]
  testOutput: string
  testPassed: boolean
  reviewVerdict: "pending" | "approved" | "rejected"
  reviewFeedback: string
  fixFeedback: string
  iterations: number
  finalSummary: string
  /** 节点执行轨迹（research/implement/fix/test/review/done 各一个条目） */
  trace: Array<{ node: string; status: string; output: string; usage: number }>
}

/** 构建编码任务图 */
export function buildCodingTaskGraph(
  registry: ToolRegistry,
  config: AgentConfig,
  options: CodingTaskOptions,
): GraphDefinition<CodingState> {

  // ── 工具执行辅助：跑 bash / read 等确定性工具 ──
  const ctx = buildToolContext(config)

  async function runTools(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>) {
    const formatted = calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }))
    const { results } = await executeToolCalls(formatted, registry, ctx, {
      provider: config.provider || "openai",
      model: config.model,
    })
    return results
  }

  /** 从 Agent 事件中提取被修改/读取的文件 */
  function extractFiles(events: unknown[]): string[] {
    const files: string[] = []
    for (const ev of events as Array<{ type?: string; name?: string; args?: Record<string, unknown> }>) {
      if (ev.type === "tool_start" || ev.type === "tool_result") {
        const name = ev.name
        const pathArg = ev.args?.path
        if ((name === "write_file" || name === "edit_file" || name === "read_file") && typeof pathArg === "string") {
          if (!files.includes(pathArg)) files.push(pathArg)
        }
      }
    }
    return files
  }

  const emitResult = (out: string, usage = 0) => ({ output: out, usage: { totalTokens: usage } })

  // ── 节点定义 ──
  const researchNode: GraphNode<CodingState> = {
    id: "research",
    kind: "agent",
    name: "需求调研",
    reads: ["request"],
    writes: ["files", "fixFeedback", "trace"],
    async run({ state, emit }) {
      emit({ type: "node_start", node: "research" })
      const prompt = [
        `你是 Mira 的调研节点。目标：了解工作区现状，为后续编码任务做准备。`,
        `编码任务：${state.request}`,
        `请快速浏览工作区结构（read_file/list_files/glob），不要修改任何文件。`,
        `最后给出 2-4 句调研结论。`,
      ].join("\n")

      const result = await runAgentNode({
        registry,
        config: { ...config, sessionID: `${config.sessionID}-graph-research` },
        prompt,
        collectEvents: options.collectEvents,
        onEvent: (e) => emit({ type: "agent_event", node: "research", event: e }),
      })

      const files = extractFiles(result.events)
      emit({ type: "node_result", node: "research", output: result.output.slice(0, 300), usage: result.usage.totalTokens })
      return {
        output: result.output,
        usage: result.usage,
        patch: { files, trace: [{ node: "research", status: result.status, output: result.output.slice(0, 200), usage: result.usage.totalTokens }] },
      }
    },
  }

  const implementNode: GraphNode<CodingState> = {
    id: "implement",
    kind: "agent",
    name: "实现/修改代码",
    reads: ["request", "fixFeedback"],
    writes: ["files", "fixFeedback", "trace"],
    async run({ state, emit }) {
      emit({ type: "node_start", node: "implement" })
      const feedback = state.fixFeedback ? `\n\n[上一轮修复反馈]\n${state.fixFeedback}` : ""
      const prompt = [
        `你是 Mira 的实现节点。请完成以下编码任务，用 write_file/edit_file 实际落盘代码：`,
        `编码任务：${state.request}`,
        feedback,
        `完成后用 bash 运行相关检查（如需），并总结改动。`,
      ].join("\n")

      const result = await runAgentNode({
        registry,
        config: { ...config, sessionID: `${config.sessionID}-graph-implement` },
        prompt,
        collectEvents: options.collectEvents,
        onEvent: (e) => emit({ type: "agent_event", node: "implement", event: e }),
      })

      const files = extractFiles(result.events)
      emit({ type: "node_result", node: "implement", output: result.output.slice(0, 300), usage: result.usage.totalTokens })
      return {
        output: result.output,
        usage: result.usage,
        patch: { files, trace: [{ node: "implement", status: result.status, output: result.output.slice(0, 200), usage: result.usage.totalTokens }] },
      }
    },
  }

  const fixNode: GraphNode<CodingState> = {
    id: "fix",
    kind: "agent",
    name: "修复问题",
    reads: ["request", "fixFeedback", "testOutput"],
    writes: ["fixFeedback", "trace", "iterations"],
    contract: {
      outputs: [{ field: "fixFeedback", required: true, type: "string" }],
    },
    async run({ state, emit }) {
      emit({ type: "node_start", node: "fix" })
      const prompt = [
        `你是 Mira 的修复节点。以下是测试失败输出，请定位并修复问题：`,
        `编码任务：${state.request}`,
        ``,
        `[测试输出]`,
        (state.testOutput || "(无测试输出)").slice(0, 4000),
        state.fixFeedback ? `\n[修复反馈]\n${state.fixFeedback}` : "",
        ``,
        `用 edit_file/write_file 修复代码，再用 bash 重跑测试确认。`,
      ].join("\n")

      const result = await runAgentNode({
        registry,
        config: { ...config, sessionID: `${config.sessionID}-graph-fix` },
        prompt,
        collectEvents: options.collectEvents,
        onEvent: (e) => emit({ type: "agent_event", node: "fix", event: e }),
      })

      emit({ type: "node_result", node: "fix", output: result.output.slice(0, 300), usage: result.usage.totalTokens })
      return {
        output: result.output,
        usage: result.usage,
        patch: {
          fixFeedback: "",
          iterations: (state.iterations || 0) + 1,
          trace: [{ node: "fix", status: result.status, output: result.output.slice(0, 200), usage: result.usage.totalTokens }],
        },
      }
    },
  }

  const testNode: GraphNode<CodingState> = {
    id: "test",
    kind: "function",
    name: "测试/校验",
    reads: [],
    writes: ["testOutput", "testPassed", "trace"],
    contract: {
      outputs: [
        { field: "testOutput", required: true, type: "string" },
        { field: "testPassed", required: true, type: "boolean" },
      ],
    },
    async run({ emit }) {
      emit({ type: "node_start", node: "test" })
      const command = options.testCommand || "pnpm typecheck"
      try {
        const results = await runTools([
          { id: "t1", name: "bash", args: { command, timeout: 180 } },
        ])
        const out = String(results.get("t1")?.output || "")
        const success = results.get("t1")?.success !== false
        emit({ type: "node_result", node: "test", passed: success })
        return {
          ...emitResult(`测试结果: ${success ? "PASS" : "FAIL"}`),
          patch: {
            testOutput: out,
            testPassed: success,
            trace: [{ node: "test", status: success ? "passed" : "failed", output: out.slice(0, 200), usage: 0 }],
          },
          usage: { totalTokens: 0 },
        }
      } catch (err) {
        logError("[Graph:test] 测试失败", err)
        return {
          ...emitResult("测试异常"),
          patch: {
            testOutput: String(err),
            testPassed: false,
            trace: [{ node: "test", status: "failed", output: String(err).slice(0, 200), usage: 0 }],
          },
        }
      }
    },
  }

  const reviewNode: GraphNode<CodingState> = {
    id: "review",
    kind: "judge",
    name: "代码审查",
    reads: ["request", "testOutput"],
    writes: ["reviewVerdict", "reviewFeedback", "trace"],
    run({ state, emit }) {
      emit({ type: "node_start", node: "review" })
      // 确定性优先：testOutput 含失败标记 → 驳回（走 fix 边）
      const verdict: CodingState["reviewVerdict"] = /fail|error|✗|failed|error\s+TS/i.test(state.testOutput)
        ? "rejected"
        : "approved"
      emit({ type: "node_result", node: "review", verdict })
      return {
        ...emitResult(`审查结论: ${verdict}`),
        patch: {
          reviewVerdict: verdict,
          reviewFeedback: verdict === "rejected" ? "测试输出存在失败标记" : "",
          trace: [{ node: "review", status: verdict, output: `审查结论: ${verdict}`, usage: 0 }],
        },
      }
    },
  }

  const doneNode: GraphNode<CodingState> = {
    id: "done",
    kind: "function",
    name: "汇总交付",
    reads: ["request", "testOutput", "files"],
    writes: ["finalSummary", "trace"],
    run({ state, emit }) {
      emit({ type: "node_start", node: "done" })
      const summary = [
        `任务完成`,
        `请求: ${state.request}`,
        `测试: ${state.testPassed ? "通过" : "未通过"}`,
        `改动文件: ${state.files.length > 0 ? state.files.join(", ") : "(无)"}`,
      ].join("\n")
      return {
        ...emitResult(summary),
        patch: {
          finalSummary: summary,
          trace: [{ node: "done", status: "completed", output: summary.slice(0, 200), usage: 0 }],
        },
      }
    },
  }

  return {
    id: "coding-task",
    name: "编码任务全流程",
    start: "research",
    end: ["done"],
    maxTotalTokens: config.maxTotalTokens,
    // 恢复策略：fix 重入上限 3 次（防止 fix→test 死循环），超限失败终止
    recovery: {
      maxReentries: { fix: 3 },
      onExhausted: "fail",
    },
    schema: {
      request: { type: "string", required: true },
      files: { type: "array", update: "append" },
      testOutput: { type: "string" },
      testPassed: { type: "boolean", required: true },
      reviewVerdict: { type: "string" },
      reviewFeedback: { type: "string" },
      fixFeedback: { type: "string" },
      iterations: { type: "number" },
      finalSummary: { type: "string" },
      trace: { type: "array", update: "append" },
    },
    nodes: [researchNode, implementNode, fixNode, testNode, reviewNode, doneNode],
    edges: [
      { from: "research", to: "implement" },
      { from: "implement", to: "test" },
      // 测试失败 → fix；通过 → review
      {
        from: "test",
        to: [
          { if: (s) => s.testPassed === true, then: "review" },
          { if: (s) => s.testPassed === false, then: "fix" },
        ],
      },
      // fix 成功后回流 test 重新验证；失败边用于 fix 自身重试
      { from: "fix", to: "test" },
      { from: "fix", to: "test", on: "failure", maxRetries: 2 },
      // review 驳回 → fix（带反馈）；批准 → done
      {
        from: "review",
        to: [
          { if: (s) => s.reviewVerdict === "approved", then: "done" },
          { if: (s) => s.reviewVerdict === "rejected", then: "fix" },
        ],
      },
    ],
  }
}

/** 便捷入口：跑一个编码任务 Graph，返回最终状态与轨迹 */
export async function runCodingTask(
  registry: ToolRegistry,
  config: AgentConfig,
  options: CodingTaskOptions,
): Promise<{ status: string; state: CodingState; error?: string; totalTokens: number }> {
  // 避免循环依赖，惰性加载 StateGraph
  const { StateGraph } = await import("../runtime")
  const planner = createCodingTaskPlanner(registry, config)
  const graph = planner.create({ request: options.request, trace: [], files: [], testOutput: "", testPassed: false, reviewVerdict: "pending", reviewFeedback: "", fixFeedback: "", iterations: 0, finalSummary: "" }, options)
  const engine = new StateGraph<CodingState>(graph)
  const result = await engine.run({
    initialState: {
      request: options.request,
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
  })
  if (result.status === "failed" && result.error) {
    logError("[Graph:runCodingTask] 编码任务失败", result.error)
  }
  return {
    status: result.status,
    state: result.state,
    error: result.error,
    totalTokens: result.totalTokens,
  }
}

/** Planner 层：编码任务图规划器（三层分离之一） */
export function createCodingTaskPlanner(
  registry: ToolRegistry,
  config: AgentConfig,
): Planner<CodingState, CodingTaskOptions> {
  return createPlanner("coding-task", (state, options) =>
    buildCodingTaskGraph(registry, config, {
      request: state.request,
      maxSteps: options?.maxSteps,
      testCommand: options?.testCommand,
      collectEvents: options?.collectEvents,
    }),
  )
}
