import { createLLMClient, type LLMToolSet, type LLMMessage, type SDKConfig } from "../llm/client"
import { FallbackClient } from "../orchestrate/failover"
import type { ToolResult, ToolContext } from "../shared/tool"
import type { ToolRegistry } from "../system/registry"
import type { AgentStateMachine } from "./state-machine"
import type { ApprovalStore } from "../system/permission/approval-store"
import type { ToolOrchestrator } from "../orchestrate/execution"
import { evaluateToolCalls, extractResources } from "../system/permission/gate"
import type { PermissionSet, PermissionRule } from "../system/permission"
import { appendMessage } from "../session/store"
import { sanitizeMessagesForLLM } from "../shared/message-utils"
import { isToolParallel } from "../tools/shared/tool-meta"
import { TextNgramMonitor } from "./text-ngram"
import { isFeatureEnabled } from "../config/flags"
import type { AgentEvent } from "../types"
import type { LLMTurnConfig } from "./turn"
import { runMaxMode, type MaxModeConfig } from "./max-mode"

export interface TurnRunnerInput {
  messages: LLMMessage[]
  tools: LLMToolSet
  sessionID: string
  workspace: string
  config: {
    provider: string
    model: string
    apiKey: string
    apiUrl: string
    headers?: Record<string, string>
    options?: Record<string, unknown>
    maxContextTokens?: number
    permissions?: PermissionSet
    onPermissionSave?: (rules: PermissionRule[]) => void
    autoAcceptPermissions?: boolean
    fallbacks?: SDKConfig[]
    visionModel?: SDKConfig["visionModel"]
    /** 主模型是否支持直接识图（vision/multimodal 直发，其余 false） */
    modelVision?: boolean
  }
  signal?: AbortSignal
  deps: {
    registry: ToolRegistry
    stateMachine: AgentStateMachine
    approvalStore: ApprovalStore
    orchestrator: ToolOrchestrator
    /** Cordis Context（可选）：工具/请求事件接缝（tools/pre-execute、agent/request） */
    cordisCtx?: import("../vendor/cordis/index").Context
  }
  ctx: ToolContext
}

export interface TurnRunnerOutput {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  toolResults: Array<{ id: string; result: ToolResult }>
  messages: LLMMessage[]
  signal: "continue" | "stop" | "context_overflow"
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  retryCount: number
  /** LLM 流错误信息（signal=stop 且由错误触发时填充） */
  error?: string
  /** DeepSeek thinking 模式的思考内容（需回传给 API） */
  reasoningContent?: string
}

/* ───────── 权限检查（串行，需要 yield 事件） ───────── */

async function* checkToolPermission(
  tc: { id: string; name: string; arguments: string },
  deps: TurnRunnerInput["deps"],
  permissions: PermissionSet | undefined,
  workspace: string,
  autoAccept: boolean | undefined,
  onPermissionSave: ((rules: PermissionRule[]) => void) | undefined,
): AsyncGenerator<AgentEvent, ToolResult | null> {
  let args: Record<string, unknown>
  try { args = JSON.parse(tc.arguments) } catch { args = {} }

  const def = deps.registry.get(tc.name)
  const permissionAction = def?.permission || tc.name
  const evaluations = evaluateToolCalls(
    [{ id: tc.id, function: { name: tc.name, arguments: JSON.stringify(args) } }],
    deps.registry,
    permissions,
  )

  for (const ev of evaluations) {
    if (ev.hardDenied) return { success: false, error: `Permission denied: ${tc.name} — ${ev.hardDenied}` }
    if (ev.denyReason) return { success: false, error: `Permission denied: ${tc.name} — ${ev.denyReason}` }
    if (ev.needsApproval) {
      const resources = extractResources(ev.args)
      const cached = deps.approvalStore.checkAll(ev.permissionAction, resources)
      if (cached === "allow") continue

      if (autoAccept) {
        deps.approvalStore.record(ev.permissionAction, resources, "allow", 300_000, workspace)
        continue
      }

      const { id, waitForReply } = deps.stateMachine.createPermissionRequest(
        onPermissionSave
          ? () => onPermissionSave([{ action: ev.permissionAction, resource: "*", effect: "allow" as const }])
          : undefined,
      )
      yield { type: "permission_request", id, action: ev.permissionAction, resources, toolCall: { id: tc.id, name: tc.name, input: args } }
      const allowed = await waitForReply()
      if (allowed) {
        deps.approvalStore.record(ev.permissionAction, resources, "allow", 300_000, workspace)
      } else {
        deps.approvalStore.record(ev.permissionAction, resources, "deny", 300_000, workspace)
        return { success: false, error: `Permission denied: ${tc.name} — user denied this request` }
      }
    }
  }

  return null
}

async function executeToolScheduled(
  tc: { id: string; name: string; arguments: string },
  input: TurnRunnerInput,
): Promise<ToolResult> {
  // invalid 自愈修复（参考 opencode）：LLM 调用不存在的工具时，
  // 先尝试小写归一，仍失败则改写为 invalid 调用，返回可读错误回流让模型自纠
  let effectiveTc = tc
  if (!input.deps.registry.get(tc.name)) {
    const lowered = tc.name.toLowerCase()
    if (input.deps.registry.get(lowered)) {
      effectiveTc = { ...tc, name: lowered }
    } else {
      effectiveTc = {
        id: tc.id,
        name: "invalid",
        arguments: JSON.stringify({ tool: tc.name, error: `Unknown tool "${tc.name}". Review the available tools and retry.` }),
      }
    }
  }

  let args: Record<string, unknown>
  try { args = JSON.parse(effectiveTc.arguments) } catch { args = {} }

  // 收敛到单一执行入口（批 10）：优先走 ctx.tools 四阶段调度器
  // （内部统一处理 tools/guard + tools/execute + tools/post-execute + tools/result）
  const toolsService = (input.deps.cordisCtx as unknown as { tools?: { executeScheduled(exec: { id: string; name: string; args: Record<string, unknown>; signal?: AbortSignal }, ctx: ToolContext, registry?: unknown): Promise<ToolResult> } } | undefined)?.tools
  if (toolsService) {
    return toolsService.executeScheduled(
      { id: effectiveTc.id, name: effectiveTc.name, args, signal: input.signal },
      input.ctx,
      input.deps.registry,
    )
  }

  // 兜底（无 tools 服务时）：保留原 guard + orchestrator 路径
  const blocked = input.deps.cordisCtx
    ? await input.deps.cordisCtx.serial("tools/guard",
        { id: effectiveTc.id, name: effectiveTc.name, arguments: JSON.stringify(args) },
        { sessionID: input.sessionID, workspace: input.workspace })
    : null
  if (blocked) return { success: false, error: String(blocked) }

  const result = await input.deps.orchestrator.execute([{ id: effectiveTc.id, name: effectiveTc.name, args }], input.ctx)
  return result.get(effectiveTc.id) || { success: false, error: "No result" }
}

/* ───────── 并发控制信号量 ───────── */

const MAX_CONCURRENT = 10

class ConcurrencyGate {
  private activeCount = 0
  private waitQueue: Array<() => void> = []
  private serialQueue: Array<() => void> = []
  private serialActive = false

  async acquire(name: string): Promise<void> {
    const parallel = isToolParallel(name)
    if (!parallel) await this.acquireSerial()
    await this.acquireShared()
  }

  release(name: string): void {
    const parallel = isToolParallel(name)
    this.releaseShared()
    if (!parallel) this.releaseSerial()
  }

  private acquireShared(): Promise<void> {
    return new Promise(resolve => {
      if (this.activeCount < MAX_CONCURRENT) { this.activeCount++; resolve() }
      else this.waitQueue.push(resolve)
    })
  }

  private releaseShared(): void {
    this.activeCount--
    if (this.waitQueue.length > 0) { this.activeCount++; this.waitQueue.shift()!() }
  }

  private acquireSerial(): Promise<void> {
    return new Promise(resolve => {
      if (!this.serialActive) { this.serialActive = true; resolve() }
      else this.serialQueue.push(resolve)
    })
  }

  private releaseSerial(): void {
    if (this.serialQueue.length > 0) { this.serialQueue.shift()!() }
    else this.serialActive = false
  }

  get busy(): boolean {
    return this.activeCount > 0 || this.serialActive
  }
}

/* ───────── 主执行函数 ───────── */

export async function* runTurn(
  input: TurnRunnerInput,
): AsyncGenerator<AgentEvent, TurnRunnerOutput> {
  const { messages, tools, config, deps, ctx, sessionID } = input
  const toolCallList: Array<{ id: string; name: string; arguments: string }> = []
  let text = ""
  let reasoningContent = ""
  let llmFailed = false
  let llmErrorMsg = ""
  const toolResults: Array<{ id: string; result: ToolResult }> = []
  let turnUsage: TurnRunnerOutput["usage"] = undefined
  let retryCount = 0

  const concurrencyGate = new ConcurrencyGate()

  const primaryConfig: SDKConfig = {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    headers: config.headers,
    options: config.options,
    visionModel: config.visionModel,
    modelVision: config.modelVision,
  }

  const client = config.fallbacks && config.fallbacks.length > 0
    ? new FallbackClient({
        primary: primaryConfig,
        fallbacks: config.fallbacks,
        onProviderError: ({ attempt, provider, error }) => {
          // 模型请求错误且降级链耗尽/切换时通知（emit：对齐 dsh agent/request-error）
          deps.cordisCtx?.emit("agent/request-error", { error, attempt, provider })
        },
      })
    : createLLMClient(primaryConfig)

  // 发送前清洗：为缺失结果的 tool-call 补 error 结果，修复消息序列（防 HTTP 400）
  // （模型请求改写统一走 agent/request 事件，在 agent.ts 触发；此处只做清洗）
  const baseRequest: { messages: LLMMessage[]; tools: typeof tools } = {
    messages: sanitizeMessagesForLLM(messages),
    tools,
  }
  const stream = client.stream({ messages: baseRequest.messages, tools: baseRequest.tools })
  const toolDoneQueue: Array<{ id: string; result: ToolResult }> = []
  const ngramMonitor = new TextNgramMonitor()

  const startToolExecution = async (tc: { id: string; name: string; arguments: string }) => {
    await concurrencyGate.acquire(tc.name)
    try {
      // 工具执行前 waterfall（对齐 dsh tools/pre-execute）：插件可改写工具名/参数
      let effectiveTc = deps.cordisCtx
        ? (deps.cordisCtx.waterfall("tools/pre-execute", tc, () => tc as never) as unknown as
            { id: string; name: string; arguments: string })
        : tc
      effectiveTc = effectiveTc ?? tc
      // 收敛到单一执行入口（批 10）：deps.cordisCtx.tools.executeScheduled
      // 内部统一处理 prepare（guard）/ dispatch（tools/execute + body）/ finalize（post-execute + tools/result）
      const result = await executeToolScheduled(effectiveTc, input)
      toolResults.push({ id: tc.id, result })
      toolDoneQueue.push({ id: tc.id, result })
    } catch (err) {
      const result = { success: false, error: err instanceof Error ? err.message : String(err) } as ToolResult
      toolResults.push({ id: tc.id, result })
      toolDoneQueue.push({ id: tc.id, result })
    } finally {
      concurrencyGate.release(tc.name)
    }
  }

  const quickPermissionCheck = (tc: { id: string; name: string; arguments: string }): { status: "allow" | "ask" | "deny"; reason?: string } => {
    if (input.config.autoAcceptPermissions) return { status: "allow" }

    let args: Record<string, unknown>
    try { args = JSON.parse(tc.arguments) } catch { args = {} }
    const def = deps.registry.get(tc.name)
    const permissionAction = def?.permission || tc.name
    const resources = extractResources(args)

    const cached = deps.approvalStore.checkAll(permissionAction, resources)
    if (cached === "allow") return { status: "allow" }

    const evaluations = evaluateToolCalls(
      [{ id: tc.id, function: { name: tc.name, arguments: tc.arguments } }],
      deps.registry,
      input.config.permissions,
    )
    const ev = evaluations[0]
    if (ev?.hardDenied) return { status: "deny", reason: `Permission denied: ${tc.name} — ${ev.hardDenied}` }
    if (ev?.denyReason) return { status: "deny", reason: `Permission denied: ${tc.name} — ${ev.denyReason}` }
    if (!ev?.needsApproval) return { status: "allow" }

    // 智能权限分类：对 bash/code_exec 按风险级别自动放行
    if (tc.name === "bash") {
      const command = typeof args.command === "string" ? args.command.trim() : ""
      if (isSafeBashCommand(command)) return { status: "allow" }
    }
    if (tc.name === "run_code") {
      const code = typeof args.code === "string" ? args.code.trim() : ""
      if (isSafeCodeExec(code)) return { status: "allow" }
    }

    return { status: "ask" }
  }

  // 参考 Claude Code 的 YOLO 分类器模式：
  // 读/查/安装等低风险命令自动放行，只有高风险命令才弹窗
  function isSafeBashCommand(command: string): boolean {
    if (!command) return false

    const firstToken = command.split(/\s+/)[0]?.toLowerCase() || ""

    // 1. 只读命令 — 永远安全
    const readOnly = new Set([
      "ls", "cat", "head", "tail", "echo", "which", "type", "pwd", "where",
      "less", "more", "wc", "sort", "uniq", "cut", "grep",
    ])
    if (readOnly.has(firstToken)) {
      const lower = command.toLowerCase()
      const dangerous = ["rm", "mv", "dd", ">", "|", "sudo", "chmod", "chown"]
      return !dangerous.some(d => lower.includes(d))
    }

    // 2. 版本/信息查询
    if (/^(python|node|npm|npx|pnpm|yarn|bun|go|rustc|pip)\s/.test(command) &&
        /\s(--version|-v|--help|-h)\s*$/.test(command)) {
      return true
    }

    // 3. 安装命令 — 低风险，自动放行
    if (/^(pip|npm|pnpm|yarn|bun|go|apt|brew|choco|winget)\s+(install|add|i|remove|uninstall)\b/.test(command)) {
      return true
    }
    if (/^(pip|npm|pnpm)\s+install\s/.test(command)) {
      return true
    }

    // 4. 包信息查询
    if (/^(pip|npm|pnpm|yarn|bun)\s+(list|show|info|search|view)\b/.test(command)) {
      return true
    }

    // 5. Git 读取操作
    if (/^git\s+(status|log|diff|show|branch|tag|stash\s+list|remote)\b/.test(command)) {
      return true
    }

    // 6. Python/Node 一次性脚本（import 检查等）
    if (firstToken === "python" || firstToken === "node") {
      const lower = command.toLowerCase()
      const nonDestructive = ["import", "print", "console.log", "require", "os."]
      if (nonDestructive.some(p => lower.includes(p)) &&
          !lower.includes("os.system") && !lower.includes("subprocess")) {
        return true
      }
    }

    // 7. find 只读查找
    if (/^find\s/.test(command) && !command.includes("exec") && !command.includes("delete")) {
      return true
    }

    return false
  }

  function isSafeCodeExec(code: string): boolean {
    if (!code) return false
    const lower = code.toLowerCase()

    // 1. 纯 import 检查 — 只验证库是否存在
    if (/^(import|from)\s+\w+/.test(code.trim()) && !code.includes("\n")) {
      return true
    }

    // 2. 只读操作：print / 计算 / 列表遍历
    if (lower.includes("print(") &&
        !lower.includes("os.system") &&
        !lower.includes("subprocess") &&
        !lower.includes("shutil.rmtree") &&
        !lower.includes("open(")) {
      return true
    }

    // 3. 只读文件操作（open 但只读模式）
    if (lower.includes('open(') && (lower.includes(".read(") || lower.includes(".readlines("))) {
      return true
    }

    return false
  }

  // ── 权限待处理队列（"ask" 的工具暂存，流结束后统一处理） ──
  interface PendingPermTool {
    toolCall: { id: string; name: string; arguments: string }
    permissionAction: string
    resources: string[]
  }
  const pendingPermissions: PendingPermTool[] = []

  // ── 流式事件处理循环 ──
  for await (const event of stream) {
    while (toolDoneQueue.length > 0) {
      const { id, result } = toolDoneQueue.shift()!
      yield { type: "tool_result" as const, id, name: toolCallList.find(t => t.id === id)?.name || "", result }
    }

    if (event.type === "delta") {
      text += event.delta
      if (isFeatureEnabled("text-ngram-detection") && ngramMonitor.check(event.delta)) {
        yield { type: "error" as const, message: "检测到重复输出，自动停止" }
        break
      }
      yield { type: "content" as const, text: event.delta }
    } else if (event.type === "reasoning-start") {
      yield { type: "reasoning-start" as const, id: event.id }
    } else if (event.type === "reasoning-delta") {
      // DeepSeek thinking 模式：累积 reasoning_content（需回传给 API）
      reasoningContent += event.delta
      yield { type: "reasoning-delta" as const, id: event.id, text: event.delta }
    } else if (event.type === "reasoning-end") {
      yield { type: "reasoning-end" as const, id: event.id }
    } else if (event.type === "tool_call" && event.toolCall) {
      toolCallList.push(event.toolCall)
      yield { type: "tool_start" as const, id: event.toolCall.id, name: event.toolCall.name, args: JSON.parse(event.toolCall.arguments) }

      // question 工具：向用户提问（前端弹窗），回答经 question:answer 回传到 sidecar 进程内 pendingQuestions
      if (event.toolCall.name === "question") {
        try {
          const qArgs = JSON.parse(event.toolCall.arguments) as { question?: string; options?: unknown }
          // 校验 options 为字符串数组，LLM 可能传字符串/对象等非法值
          const opts = Array.isArray(qArgs.options)
            ? qArgs.options.filter((o): o is string => typeof o === "string")
            : undefined
          yield { type: "question" as const, id: event.toolCall.id, question: qArgs.question || "请回答", options: opts }
        } catch { /* 参数解析失败忽略 */ }
      }

      const permResult = quickPermissionCheck(event.toolCall)

      if (permResult.status === "allow") {
        startToolExecution(event.toolCall)
      } else if (permResult.status === "deny") {
        const result = { success: false, error: permResult.reason || `Permission denied: ${event.toolCall.name}` } as ToolResult
        toolResults.push({ id: event.toolCall.id, result })
        toolDoneQueue.push({ id: event.toolCall.id, result })
      } else {
        let args: Record<string, unknown>
        try { args = JSON.parse(event.toolCall.arguments) } catch { args = {} }
        const def = deps.registry.get(event.toolCall.name)
        const permissionAction = def?.permission || event.toolCall.name
        const resources = extractResources(args)
        pendingPermissions.push({ toolCall: event.toolCall, permissionAction, resources })
      }
    } else if (event.type === "retry") {
      retryCount = event.attempt
      yield { type: "retry" as const, attempt: event.attempt, error: event.error }
    } else if (event.type === "error") {
      const errMsg = (event.error?.message || "").toLowerCase()
      if (errMsg.includes("prompt_too_long") || errMsg.includes("context_length_exceeded") || errMsg.includes("too many tokens")) {
        return { text, toolCalls: toolCallList, signal: "context_overflow" as const, messages, toolResults, usage: turnUsage, retryCount, reasoningContent }
      }
      llmFailed = true
      llmErrorMsg = event.error?.message || "LLM stream error"
      // Agent 回合错误（emit：观察方监听 agent/error 感知回合级失败）
      deps.cordisCtx?.emit("agent/error", { error: llmErrorMsg })
      yield { type: "error" as const, message: llmErrorMsg }
      break
    } else if (event.type === "done") {
      turnUsage = event.usage
      break
    }
  }

  // ── 流结束后统一处理权限队列（不阻塞 LLM 流） ──
  for (const pp of pendingPermissions) {
    const { id: permId, waitForReply } = deps.stateMachine.createPermissionRequest(
      config.onPermissionSave
        ? () => config.onPermissionSave?.([{ action: pp.permissionAction, resource: "*", effect: "allow" as const }])
        : undefined,
    )
    yield { type: "permission_request", id: permId, action: pp.permissionAction, resources: pp.resources, toolCall: { id: pp.toolCall.id, name: pp.toolCall.name, input: JSON.parse(pp.toolCall.arguments) } }
    const allowed = await waitForReply()

    if (allowed) {
      deps.approvalStore.record(pp.permissionAction, pp.resources, "allow", 86400_000, input.workspace)
      startToolExecution(pp.toolCall)
    } else {
      deps.approvalStore.record(pp.permissionAction, pp.resources, "deny", 300_000, input.workspace)
      const result = { success: false, error: `Permission denied: ${pp.toolCall.name} — user denied this request` } as ToolResult
      toolResults.push({ id: pp.toolCall.id, result })
      toolDoneQueue.push({ id: pp.toolCall.id, result })
    }
  }

  // 等待所有工具执行完成
  while (concurrencyGate.busy || toolDoneQueue.length > 0) {
    while (toolDoneQueue.length > 0) {
      const { id, result } = toolDoneQueue.shift()!
      yield { type: "tool_result" as const, id, name: toolCallList.find(t => t.id === id)?.name || "", result }
    }
    if (!concurrencyGate.busy && toolDoneQueue.length === 0) break
    await new Promise(r => setTimeout(r, 10))
  }

  while (toolDoneQueue.length > 0) {
    const { id, result } = toolDoneQueue.shift()!
    yield { type: "tool_result" as const, id, name: toolCallList.find(t => t.id === id)?.name || "", result }
  }

  if (llmFailed) {
    return { text, toolCalls: toolCallList, signal: "stop" as const, messages, toolResults, usage: turnUsage, retryCount, error: llmErrorMsg, reasoningContent }
  }

  // ── 将工具结果追加到消息列表 ──
  if (toolCallList.length > 0) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text" as const, text },
        ...toolCallList.map(tc => ({
          type: "tool-call" as const,
          toolCallId: tc.id,
          toolName: tc.name,
          args: JSON.parse(tc.arguments),
        })),
      ],
      // 携带 reasoning_content，保证下一轮请求能原样回传（DeepSeek thinking 必需）
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    })

    const resultMap = new Map(toolResults.map(r => [r.id, r.result]))
    for (const tc of toolCallList) {
      const result = resultMap.get(tc.id)
      const rawText = result?.success ? (result.output || "") : (result?.error || result?.output || "No result")
      // 即时截断超大工具结果，避免 50000 字符直接注入上下文（参考 OpenCode tool-output-store）
      const resultText = truncateToolResult(rawText)
      messages.push({
        role: "tool",
        content: [{ type: "tool-result" as const, toolCallId: tc.id, toolName: tc.name, output: resultText }],
        tool_call_id: tc.id,
      })
      // 图片工具结果（如 read_file 读取图片）：base64 数据在 metadata 中，
      // 需以 ImagePart 注入 user 消息，视觉模型才能"看到"图片
      const imgMeta = result?.metadata as { mime?: string; data?: string; name?: string } | undefined
      if (result?.success && imgMeta?.mime && imgMeta?.data) {
        messages.push({
          role: "user",
          content: [
            { type: "text" as const, text: `[图片] ${imgMeta.name || tc.name} 的内容如下，请查看：` },
            { type: "image" as const, image: `data:${imgMeta.mime};base64,${imgMeta.data}`, mediaType: imgMeta.mime },
          ],
        })
      }
    }

    // 持久化到 DB：顺序必须为 assistant(含 tool_calls) → tool 结果，
    // 否则 OpenAI 兼容 API 收到孤立 tool 消息会返回 400
    const hasToolCalls = toolCallList.length > 0
    if (hasToolCalls) {
      // 1. 先落 assistant（含 tool_calls 的 JSON）
      await appendMessage(sessionID, {
        role: "assistant",
        content: JSON.stringify({
          text: text || "",
          tool_calls: toolCallList.map(tc => ({ id: tc.id, name: tc.name, args: tc.arguments })),
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        }),
        timestamp: new Date().toISOString(),
        retryCount,
      })
      // 2. 再落 tool 结果（顺序紧随对应 assistant）
      for (const tr of toolResults) {
        const tc = toolCallList.find(t => t.id === tr.id)
        if (tc) {
          await appendMessage(sessionID, {
            role: "tool",
            content: tr.result.output || tr.result.error || "",
            timestamp: new Date().toISOString(),
            toolCallId: tc.id,
          })
        }
      }
    }
  }

  return { text, toolCalls: toolCallList, signal: "continue" as const, messages, toolResults, usage: turnUsage, retryCount, reasoningContent }
}

/* ───────── Max Mode 支持 ───────── */

export async function* runMaxModeTurn(
  input: TurnRunnerInput & {
    maxModeConfig: { n: number; candidateConfig: LLMTurnConfig; judgeConfig?: LLMTurnConfig }
  },
): AsyncGenerator<AgentEvent, TurnRunnerOutput> {
  const { messages, tools } = input
  const { n, candidateConfig, judgeConfig } = input.maxModeConfig

  const maxResult = yield* runMaxMode({
    messages,
    tools,
    config: { n, candidateConfig, judgeConfig },
  })

  if (!maxResult.text && (!maxResult.toolCalls || maxResult.toolCalls.length === 0)) {
    return { text: "", toolCalls: [], toolResults: [], messages, signal: "stop" as const, retryCount: 0, error: "Max Mode 所有候选与降级调用均未返回有效输出" }
  }

  const toolCallsArray = (maxResult.toolCalls || [])
    .filter((tc) => tc.id && tc.name)
    .map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }))

  // 注入 assistant 消息
  messages.push({
    role: "assistant",
    content: [
      { type: "text" as const, text: maxResult.text },
      ...toolCallsArray.map(tc => ({
        type: "tool-call" as const,
        toolCallId: tc.id,
        toolName: tc.function.name,
        args: JSON.parse(tc.function.arguments),
      })),
    ],
  })

  await appendMessage(input.sessionID, {
    role: "assistant",
    content: toolCallsArray.length > 0
      ? JSON.stringify({
          text: maxResult.text || "",
          tool_calls: toolCallsArray.map(tc => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })),
        })
      : (maxResult.text || ""),
    timestamp: new Date().toISOString(),
  })

  // 执行工具
  const toolResults: Array<{ id: string; result: ToolResult }> = []
  if (toolCallsArray.length > 0) {
    for (const tc of toolCallsArray) {
      const permCheck = yield* checkToolPermission(
        { id: tc.id, name: tc.function.name, arguments: tc.function.arguments },
        input.deps,
        input.config.permissions,
        input.workspace,
        input.config.autoAcceptPermissions,
        input.config.onPermissionSave,
      )
      if (permCheck) {
        toolResults.push({ id: tc.id, result: permCheck })
      } else {
        const result = await executeToolScheduled(
          { id: tc.id, name: tc.function.name, arguments: tc.function.arguments },
          input,
        )
        toolResults.push({ id: tc.id, result })
      }
    }

    const resultMap = new Map(toolResults.map(r => [r.id, r.result]))
    for (const tc of toolCallsArray) {
      const result = resultMap.get(tc.id)
      const resultText = result?.success ? (result.output || "") : (result?.error || result?.output || "No result")
      yield { type: "tool_result", id: tc.id, name: tc.function.name, result: result || { success: false, error: "No result" } }
      messages.push({
        role: "tool",
        content: [{ type: "tool-result" as const, toolCallId: tc.id, toolName: tc.function.name, output: resultText }],
        tool_call_id: tc.id,
      })
      // 图片工具结果：以 ImagePart 注入 user 消息，视觉模型才能"看到"图片
      const imgMeta = result?.metadata as { mime?: string; data?: string; name?: string } | undefined
      if (result?.success && imgMeta?.mime && imgMeta?.data) {
        messages.push({
          role: "user",
          content: [
            { type: "text" as const, text: `[图片] ${imgMeta.name || tc.function.name} 的内容如下，请查看：` },
            { type: "image" as const, image: `data:${imgMeta.mime};base64,${imgMeta.data}`, mediaType: imgMeta.mime },
          ],
        })
      }
      // 落库 tool 结果（顺序在 assistant 之后，与 runTurn 保持一致）
      await appendMessage(input.sessionID, {
        role: "tool",
        content: resultText,
        timestamp: new Date().toISOString(),
        toolCallId: tc.id,
      })
    }
  }

  return { text: maxResult.text, toolCalls: maxResult.toolCalls || [], toolResults, messages, signal: "continue" as const, retryCount: 0 }
}

/**
 * 截断超大工具结果（注入上下文前）：
 * 超过 MAX_TOOL_RESULT_CHARS 时头尾各保留一半，中间用省略标记。
 * 防止 web_fetch 等工具的 50000 字符输出直接撑爆上下文。
 */
const MAX_TOOL_RESULT_CHARS = 6000

function truncateToolResult(text: string): string {
  if (!text || text.length <= MAX_TOOL_RESULT_CHARS) return text
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2)
  return `${text.slice(0, half)}\n\n... [output truncated: ${text.length} chars total, saved full output to tool output store] ...\n\n${text.slice(-half)}`
}
