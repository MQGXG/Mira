/**
 * Graph 引擎测试
 * 覆盖：条件边路由 / fan-out 汇合 / checkpoint 恢复 / next_node 白名单 / 预算闸门 / 写白名单
 *       / 并行组（all_of / any_of join）/ 契约校验 / 迭代收敛（Recovery）/ Planner
 */

import { describe, it, expect } from "vitest"
import { StateGraph } from "../graph/runtime"
import { StateStore } from "../graph/state"
import { Recovery, mergeRecoveryPolicies } from "../graph/recovery"
import { createPlanner, composePlanner } from "../graph/planner"
import type { GraphDefinition, GraphState } from "../graph/types"
import { buildCodingTaskGraph, createCodingTaskPlanner } from "../graph/templates/coding-task"
import { ToolRegistry } from "../system/registry"
import type { AgentConfig } from "../agent/constants"

interface TestState extends GraphState {
  value: string
  log: string[]
  counter: number
}

function makeGraph(overrides?: Partial<GraphDefinition<TestState>>): GraphDefinition<TestState> {
  const def: GraphDefinition<TestState> = {
    id: "test-graph",
    name: "Test",
    start: "a",
    end: ["end"],
    schema: {
      value: { type: "string" },
      log: { type: "array", update: "append" },
      counter: { type: "number" },
    },
    nodes: [
      {
        id: "a",
        kind: "function",
        name: "A",
        writes: ["value", "log"],
        run: ({ state, emit }) => {
          emit({ type: "node_a", value: state.value })
          return { patch: { value: "from-a", log: ["a"] } }
        },
      },
      {
        id: "b",
        kind: "function",
        name: "B",
        writes: ["value", "log"],
        run: () => ({ patch: { value: "from-b", log: ["b"] } }),
      },
      {
        id: "c",
        kind: "function",
        name: "C",
        writes: ["counter"],
        run: () => ({ patch: { counter: 1 } }),
      },
      {
        id: "end",
        kind: "function",
        name: "End",
        writes: ["log"],
        run: () => ({ patch: { log: ["end"] } }),
      },
    ],
    edges: [
      {
        from: "a",
        to: [
          { if: (s) => s.value === "from-a", then: "b" },
          { if: (s) => s.value === "other", then: "c" },
        ],
      },
      { from: "b", to: "end" },
      { from: "c", to: "end" },
    ],
    ...overrides,
  }
  return def
}

describe("StateStore", () => {
  it("replace 策略整体覆盖", () => {
    const store = new StateStore<TestState>(
      { value: "x", log: [], counter: 0 },
      { value: { type: "string" }, log: { type: "array", update: "append" }, counter: { type: "number" } },
    )
    store.write({ value: "y" })
    expect(store.get().value).toBe("y")
  })

  it("append 策略追加而非覆盖", () => {
    const store = new StateStore<TestState>(
      { value: "", log: ["init"], counter: 0 },
      { value: { type: "string" }, log: { type: "array", update: "append" }, counter: { type: "number" } },
    )
    store.write({ log: ["a", "b"] })
    expect(store.get().log).toEqual(["init", "a", "b"])
  })

  it("写白名单拦截越权字段", () => {
    const store = new StateStore<TestState>({ value: "", log: [], counter: 0 })
    expect(() => store.write({ value: "x" }, ["counter"])).toThrow(/forbidden field/)
  })

  it("Schema 类型校验", () => {
    const store = new StateStore<TestState>(
      { value: "", log: [], counter: 0 },
      { counter: { type: "number" } },
    )
    // @ts-expect-error 故意传错误类型
    expect(() => store.write({ counter: "not-a-number" })).toThrow(/expected number/)
  })
})

describe("StateGraph", () => {
  it("条件边路由走正确分支", async () => {
    const engine = new StateGraph<TestState>(makeGraph())
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("completed")
    expect(result.state.value).toBe("from-b")
    expect(result.state.log).toContain("end")
  })

  it("条件边另一分支", async () => {
    const def = makeGraph({
      nodes: [
        {
          id: "a",
          kind: "function" as const,
          name: "A",
          writes: ["value", "log"],
          run: () => ({ patch: { value: "other", log: ["a"] } }),
        },
        ...makeGraph().nodes.slice(1),
      ],
    })
    const engine = new StateGraph<TestState>(def)
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("completed")
    expect(result.state.value).toBe("other") // 走 c 分支，value 保持 other
  })

  it("访问轨迹记录完整", async () => {
    const engine = new StateGraph<TestState>(makeGraph())
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.visited).toEqual(["a", "b", "end"])
  })

  it("next_node 越权被拒绝", async () => {
    const def = makeGraph({
      nodes: [
        {
          id: "a",
          kind: "function" as const,
          name: "A",
          run: () => ({ patch: {}, next_node: "end" }), // 越权：a 的出边白名单是 b/c
        },
        ...makeGraph().nodes.slice(1),
      ],
    })
    const engine = new StateGraph<TestState>(def)
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/not in allowed targets/)
  })

  it("checkpoint 落盘并可恢复", async () => {
    const engine = new StateGraph<TestState>(makeGraph())
    await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    const runs = engine.listRuns()
    expect(runs.length).toBeGreaterThanOrEqual(1)
    const checkpoint = runs[0]
    expect(checkpoint.completedNodes).toEqual(["a", "b", "end"])

    const resumed = await engine.run({ resumeRunId: checkpoint.runId })
    expect(resumed.status).toBe("completed")
    expect(resumed.state.value).toBe("from-b")
  })

  it("预算闸门超限终止", async () => {
    const base = makeGraph({ maxTotalTokens: 3 })
    // 给 a 节点返回 usage，触发预算检查；保持原有路由行为
    base.nodes = base.nodes.map((n) => (n.id === "a"
      ? { ...n, run: () => ({ patch: { value: "from-a", log: ["a"] }, usage: { totalTokens: 5 } }) }
      : n))
    const engine = new StateGraph<TestState>(base)
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("budget_exceeded")
    expect(result.totalTokens).toBeGreaterThanOrEqual(3)
  })

  it("节点失败重试后走 fallback", async () => {
    let attempts = 0
    const def = makeGraph({
      nodes: [
        {
          id: "a",
          kind: "function" as const,
          name: "A",
          run: () => {
            attempts++
            throw new Error("boom")
          },
        },
        ...makeGraph().nodes.slice(1),
      ],
      edges: [
        { from: "a", to: "b", on: "failure", maxRetries: 2, fallback: "c" },
        { from: "b", to: "end" },
        { from: "c", to: "end" },
      ],
    })
    const engine = new StateGraph<TestState>(def)
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(attempts).toBe(3) // 1 次执行 + 2 次重试
    expect(result.status).toBe("completed")
    expect(result.state.counter).toBe(1) // 走到了 c
  })
})

describe("CodingTask 模板", () => {
  function makeConfig(): AgentConfig {
    return {
      sessionID: "test-session",
      workspace: ".",
      model: "test-model",
      apiKey: "test-key",
      apiUrl: "http://localhost",
    }
  }

  it("模板定义完整（6 节点 6 边）", () => {
    const def = buildCodingTaskGraph(new ToolRegistry(), makeConfig(), {
      request: "修复测试",
    })
    expect(def.id).toBe("coding-task")
    expect(def.start).toBe("research")
    expect(def.end).toEqual(["done"])
    expect(def.nodes.map((n) => n.id)).toEqual(["research", "implement", "fix", "test", "review", "done"])
    // research/implement/fix 是真实 Agent 节点
    expect(def.nodes.filter((n) => n.kind === "agent").map((n) => n.id)).toEqual(["research", "implement", "fix"])
    expect(def.edges).toHaveLength(6)
  })

  it("测试失败时经 fix 回流，通过时走 review", async () => {
    // 只跑 test/review/done 子图：初始 testPassed=false → 走 fix 条件边
    const def = buildCodingTaskGraph(new ToolRegistry(), makeConfig(), {
      request: "x",
      testCommand: "echo ok",
    })
    const def2: GraphDefinition<{ testPassed: boolean } & GraphState> = {
      id: "coding-task-slice",
      name: "slice",
      start: "test",
      end: ["done"],
      schema: { testPassed: { type: "boolean", required: true } },
      nodes: def.nodes.filter((n) => ["test", "review", "done"].includes(n.id)) as never,
      edges: def.edges.filter((e) => !["research", "implement", "fix"].includes(e.from)) as never,
    }
    const engine = new StateGraph(def2 as never)
    // test 节点调用 bash，需要 registry 支持；这里验证路由定义而非执行
    const failEdge = def.edges.find((e) => e.from === "test")
    expect(failEdge).toBeDefined()
    expect(failEdge!.to).toHaveLength(2)
    const branches = failEdge!.to as Array<{ if: (s: unknown) => boolean; then: string }>
    expect(branches[0].then).toBe("review")
    expect(branches[1].then).toBe("fix")
    expect(branches[0].if({ testPassed: true })).toBe(true)
    expect(branches[1].if({ testPassed: false })).toBe(true)
  })

  it("review 确定性驳回失败测试输出", () => {
    const def = buildCodingTaskGraph(new ToolRegistry(), makeConfig(), { request: "x" })
    const review = def.nodes.find((n) => n.id === "review")!
    const reviewEdge = def.edges.find((e) => e.from === "review")!
    const branches = reviewEdge.to as Array<{ if: (s: unknown) => boolean; then: string }>
    expect(branches.find((b) => b.then === "done")!.if({ reviewVerdict: "approved" })).toBe(true)
    expect(branches.find((b) => b.then === "fix")!.if({ reviewVerdict: "rejected" })).toBe(true)
    void review
  })

  it("fix 节点带 contract 声明 + iterations 计数", () => {
    const def = buildCodingTaskGraph(new ToolRegistry(), makeConfig(), { request: "x" })
    const fix = def.nodes.find((n) => n.id === "fix")!
    expect(fix.contract?.outputs?.some((o) => o.field === "fixFeedback" && o.required)).toBe(true)
    expect(def.recovery?.maxReentries?.fix).toBe(3)
    expect(def.recovery?.onExhausted).toBe("fail")
  })

  it("fix 成功后回流 test 重新验证（有 success 出边）", () => {
    const def = buildCodingTaskGraph(new ToolRegistry(), makeConfig(), { request: "x" })
    const fixEdges = def.edges.filter((e) => e.from === "fix")
    // 必须有 success（或默认）边回流 test：否则 fix 成功后无法继续路由，图被判定未达终点
    const successEdge = fixEdges.find((e) => e.on === "success" || !e.on)
    expect(successEdge).toBeDefined()
    expect(successEdge!.to).toBe("test")
  })

  it("Planner 生成与模板等价，且可组合装饰", () => {
    const planner = createCodingTaskPlanner(new ToolRegistry(), makeConfig())
    const def = planner.create(
      { request: "x", trace: [], files: [], testOutput: "", testPassed: false, reviewVerdict: "pending", reviewFeedback: "", fixFeedback: "", iterations: 0, finalSummary: "" },
      { request: "x" },
    )
    expect(planner.graphId).toBe("coding-task")
    expect(def.nodes.map((n) => n.id)).toEqual(["research", "implement", "fix", "test", "review", "done"])

    const decorated = composePlanner(planner, (d) => ({ ...d, name: d.name + " (decorated)" }))
    const def2 = decorated.create({ request: "x", trace: [], files: [], testOutput: "", testPassed: false, reviewVerdict: "pending", reviewFeedback: "", fixFeedback: "", iterations: 0, finalSummary: "" }, { request: "x" })
    expect(def2.name).toBe("编码任务全流程 (decorated)")
  })
})

describe("Recovery（迭代收敛）", () => {
  it("单节点重入超限后拒绝", () => {
    const rec = new Recovery({ maxReentries: { fix: 3 }, onExhausted: "fail" })
    for (let i = 1; i <= 3; i++) expect(rec.beforeNode("fix").allowed).toBe(true)
    const denied = rec.beforeNode("fix")
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toMatch(/re-entered 4 times/)
    expect(rec.reentryCount("fix")).toBe(4)
  })

  it("全局执行上限生效", () => {
    const rec = new Recovery({ maxTotalExecutions: 5 })
    for (let i = 1; i <= 5; i++) expect(rec.beforeNode("a").allowed).toBe(true)
    expect(rec.beforeNode("a").allowed).toBe(false)
  })

  it("escalate 决策遵循策略", () => {
    expect(new Recovery({ onExhausted: "escalate" }).escalate("x")).toBe("escalate")
    expect(new Recovery().escalate("x")).toBe("fail")
  })

  it("策略合并（后者覆盖同名 key）", () => {
    const merged = mergeRecoveryPolicies(
      { maxReentries: { fix: 2, test: 5 }, onExhausted: "fail" },
      { maxReentries: { fix: 4 }, maxTotalExecutions: 10 },
    )
    expect(merged?.maxReentries?.fix).toBe(4)
    expect(merged?.maxReentries?.test).toBe(5)
    expect(merged?.maxTotalExecutions).toBe(10)
    expect(merged?.onExhausted).toBe("fail")
  })
})

describe("StateGraph 并行组（join）", () => {
  interface JoinState extends GraphState {
    value: string
    log: string[]
    counter: number
  }

  function makeParallelGraph(
    mode: "all_of" | "any_of",
    branchBThrows = false,
    branchCThrows = false,
  ): GraphDefinition<JoinState> {
    return {
      id: "parallel-graph",
      name: "Parallel",
      start: "a",
      end: ["join"],
      schema: {
        value: { type: "string" },
        log: { type: "array", update: "append" },
        counter: { type: "number" },
      },
      parallels: [{ id: "a", branches: ["b", "c"], join: "join", mode }],
      nodes: [
        {
          id: "a",
          kind: "function",
          name: "A (fan-out)",
          writes: ["log"],
          run: () => ({ patch: { log: ["a"] } }),
        },
        {
          id: "b",
          kind: "function",
          name: "B",
          writes: ["value", "log"],
          run: () => {
            if (branchBThrows) throw new Error("branch b failed")
            return { patch: { value: "from-b", log: ["b"] } }
          },
        },
        {
          id: "c",
          kind: "function",
          name: "C",
          writes: ["counter", "log"],
          run: () => {
            if (branchCThrows) throw new Error("branch c failed")
            return { patch: { counter: 1, log: ["c"] } }
          },
        },
        {
          id: "join",
          kind: "function",
          name: "Join",
          writes: ["log"],
          run: () => ({ patch: { log: ["join"] } }),
        },
      ],
      edges: [
        { from: "b", to: "join" },
        { from: "c", to: "join" },
      ],
    }
  }

  it("all_of 汇聚全部分支结果", async () => {
    const engine = new StateGraph<JoinState>(makeParallelGraph("all_of"))
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("completed")
    expect(result.state.value).toBe("from-b")
    expect(result.state.counter).toBe(1)
    expect(result.state.log).toEqual(["a", "b", "c", "join"])
    expect(result.visited).toContain("b")
    expect(result.visited).toContain("c")
    expect(result.visited).toContain("join")
  })

  it("all_of 任一分支失败 → 整体失败", async () => {
    const engine = new StateGraph<JoinState>(makeParallelGraph("all_of", true))
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/Parallel group "a" failed/)
    expect(result.error).toMatch(/branch b failed/)
  })

  it("any_of 任一分支成功即可放行", async () => {
    // b 失败，c 成功 → any_of 仍通过
    const engine = new StateGraph<JoinState>(makeParallelGraph("any_of", true, false))
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("completed")
    expect(result.state.counter).toBe(1)
    expect(result.state.value).toBe("") // b 失败未写 value
  })

  it("any_of 全部分支失败 → 整体失败", async () => {
    const engine = new StateGraph<JoinState>(makeParallelGraph("any_of", true, true))
    const result = await engine.run({
      initialState: { value: "", log: [], counter: 0 },
    })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/Parallel group "a" failed/)
  })
})

describe("StateGraph 契约校验（contract）", () => {
  interface ContractState extends GraphState {
    result: string
  }

  it("required 输出缺失 → 契约失败", async () => {
    const def: GraphDefinition<ContractState> = {
      id: "contract-graph",
      name: "Contract",
      start: "a",
      end: ["end"],
      schema: { result: { type: "string" } },
      nodes: [
        {
          id: "a",
          kind: "function",
          name: "A",
          writes: [],
          contract: { outputs: [{ field: "result", required: true, type: "string" }] },
          run: () => ({ patch: {} }), // 未产出 result
        },
        {
          id: "end",
          kind: "function",
          name: "End",
          run: () => ({}),
        },
      ],
      edges: [{ from: "a", to: "end" }],
    }
    const engine = new StateGraph<ContractState>(def)
    const result = await engine.run({ initialState: { result: "" } })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/contract violated: required output "result" missing/)
  })

  it("输出类型不符 → 契约失败", async () => {
    const def: GraphDefinition<ContractState> = {
      id: "contract-type",
      name: "ContractType",
      start: "a",
      end: ["end"],
      // schema 不含 result，类型交由 contract 显式校验（避免 StateStore 先拦截）
      schema: {},
      nodes: [
        {
          id: "a",
          kind: "function",
          name: "A",
          writes: ["result"],
          contract: { outputs: [{ field: "result", type: "string" }] },
          run: () => ({ patch: { result: 123 as never } }), // 类型不符
        },
        {
          id: "end",
          kind: "function",
          name: "End",
          run: () => ({}),
        },
      ],
      edges: [{ from: "a", to: "end" }],
    }
    const engine = new StateGraph<ContractState>(def)
    const result = await engine.run({ initialState: { result: "" } })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/contract violated: "result" expected string/)
  })

  it("满足契约 → 正常运行", async () => {
    const def: GraphDefinition<ContractState> = {
      id: "contract-ok",
      name: "ContractOk",
      start: "a",
      end: ["end"],
      schema: { result: { type: "string" } },
      nodes: [
        {
          id: "a",
          kind: "function",
          name: "A",
          writes: ["result"],
          contract: { outputs: [{ field: "result", required: true, type: "string" }] },
          run: () => ({ patch: { result: "ok" } }),
        },
        {
          id: "end",
          kind: "function",
          name: "End",
          run: () => ({}),
        },
      ],
      edges: [{ from: "a", to: "end" }],
    }
    const engine = new StateGraph<ContractState>(def)
    const result = await engine.run({ initialState: { result: "" } })
    expect(result.status).toBe("completed")
    expect(result.state.result).toBe("ok")
  })
})

describe("StateGraph 迭代收敛（Recovery 集成）", () => {
  interface LoopState extends GraphState {
    counter: number
  }

  it("fix 重入超限 → 失败终止（防死循环）", async () => {
    const def: GraphDefinition<LoopState> = {
      id: "loop-graph",
      name: "Loop",
      start: "fix",
      end: ["done"],
      schema: { counter: { type: "number" } },
      recovery: { maxReentries: { fix: 3 }, onExhausted: "fail" },
      nodes: [
        {
          id: "fix",
          kind: "function",
          name: "Fix",
          writes: ["counter"],
          run: ({ state }) => ({ patch: { counter: (state.counter || 0) + 1 } }),
        },
        {
          id: "test",
          kind: "function",
          name: "Test",
          run: () => ({}),
        },
        {
          id: "done",
          kind: "function",
          name: "Done",
          run: () => ({}),
        },
      ],
      edges: [
        // fix 永远回流 test → test 回流 fix：死循环被 Recovery 拦截
        { from: "fix", to: "test" },
        { from: "test", to: "fix" },
      ],
    }
    const engine = new StateGraph<LoopState>(def)
    const result = await engine.run({ initialState: { counter: 0 } })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/Iteration exhausted/)
    expect(result.state.counter).toBe(3)
  })

  it("escalate 策略超限时走失败回退边", async () => {
    const def: GraphDefinition<LoopState> = {
      id: "escalate-graph",
      name: "Escalate",
      start: "fix",
      end: ["done"],
      schema: { counter: { type: "number" } },
      recovery: { maxReentries: { fix: 2 }, onExhausted: "escalate" },
      nodes: [
        {
          id: "fix",
          kind: "function",
          name: "Fix",
          writes: ["counter"],
          run: ({ state }) => ({ patch: { counter: (state.counter || 0) + 1 } }),
        },
        {
          id: "test",
          kind: "function",
          name: "Test",
          run: () => ({}),
        },
        {
          id: "done",
          kind: "function",
          name: "Done",
          run: () => ({ patch: { counter: 999 } }),
        },
      ],
      edges: [
        { from: "fix", to: "test" },
        { from: "test", to: "fix" },
        { from: "fix", to: "done", on: "failure", fallback: "done" },
      ],
    }
    const engine = new StateGraph<LoopState>(def)
    const result = await engine.run({ initialState: { counter: 0 } })
    expect(result.status).toBe("completed")
    expect(result.state.counter).toBe(999) // 升级到 done
  })
})
