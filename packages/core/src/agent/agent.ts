import type { ToolRegistry } from "../system/registry"
import type { AgentEvent } from "../types"
import { join } from "path"
import { logInfo } from "../system/logger"
import { TokenUsageAccumulator } from "../session/token-projection"
import type { LLMMessage } from "../llm/client"
import { estimateTokens } from "../shared/message-utils"
import { calculateCost, getModelPricing } from "../shared/cost"
import type { PermissionRule } from "../system/permission"
import { MemoryManager } from "../memory/manager"
import type { DynamicMemoryManager} from "../memory/dynamic-memory";
import { createDynamicMemory } from "../memory/dynamic-memory"
import { setDynamicMemoryManager } from "../tools/knowledge/memory-activate"
import { BuiltinMemoryProvider } from "../memory/builtin-provider"
import { appendMessage } from "../session/store"
import { VectorMemoryProvider } from "../memory/vector-provider"
import { FileMemoryProvider } from "../memory/file-memory-provider"
import { FTSMemoryProvider } from "../memory/fts-memory-provider"
import { CheckpointProvider } from "../memory/checkpoint-provider"
import { setFTSProvider } from "../tools/knowledge/memory"
import { ToolOrchestrator } from "../orchestrate/execution"
import { AgentStateMachine, type AgentStatus } from "./state-machine"
import type { SourceManager } from "../session/context-source"
import { ApprovalStore } from "../system/permission/approval-store"
import { DreamDistillManager } from "../orchestrate/dream"
import { ContextManager } from "../session/context"
import { GoalJudge } from "../orchestrate/goal-judge"
import { getModeMaxIterations } from "../config/modes"
import { type AgentConfig } from "./constants"

import { classifyStep, isTerminal, isRecovery, MAX_STEPS_WARNING, MAX_STEPS_REACHED } from "./turn-classifier"
import { runTurn, runMaxModeTurn, type TurnRunnerInput, type TurnRunnerOutput } from "./turn-runner"
import { runStopHooks, registerStopHook, autoDreamHook, memoryPromoteHook } from "./stop-hooks"
import { PendingInputQueue, type QueueItem, type InputType, type InboxBoundary, type InboxSpliceOp, type InboxSpliceKind } from "./input-queue"
import { prepareRun, restoreSession, buildMessages, handleTurn, finalizeRun, persistUploadedImages, injectGraphMemoryStage } from "./stages"

export type PermissionReply = "allow" | "deny" | "always"

export type { AgentConfig } from "./constants"

export type { AgentEvent } from "../types"

// Cordis Context（可选注入）：Agent 循环扩展点（agent/pre-step 等类型化事件）
import type { Context as MiraContext } from "../vendor/cordis/index"
import { scopeTarget, type Scoped } from "../scope/index"

/** 用户附带的文件路径引用（文本/Office，不落库内容） */
export interface FileRef {
  name: string
  path?: string
  kind?: string
}
export class Agent {
  private stateMachine = new AgentStateMachine()
  private memoryManager!: MemoryManager
  private dynamicMemory!: DynamicMemoryManager
  private approvalStore!: ApprovalStore
  private orchestrator!: ToolOrchestrator
  private checkpointProvider!: CheckpointProvider
  private dreamDistillManager!: DreamDistillManager
  private contextManager!: ContextManager
  private goalJudge!: GoalJudge

  /** Cordis Context（可选）：Agent 循环插件扩展点 */
  private miraCtx: MiraContext | null = null

  /** 作用域 id（=sessionID）：ctx.agents 注册身份；未附加作用域时为 undefined */
  id: string | undefined

  /** agent 作用域上下文（createScope 铸造，ctx.agent 指向本 Agent） */
  agentCtx: MiraContext | undefined

  /** System Context Sources — 增量式系统上下文管理 */
  private sourceManager: SourceManager | null = null
  private sourceManagerSources: {
    memory: import("../session/context-source").MemorySource
    code: import("../session/context-source").CodeSource
    goal: import("../session/context-source").GoalSource
    mode: import("../session/context-source").ModeSource
    knowledge: import("../session/context-source").KnowledgeSource
  } | null = null

  /** VectorMemoryProvider 惰性初始化，避免构造函数中网络阻塞 */
  private _vectorProvider: VectorMemoryProvider | null = null

  /** 文本 N-gram 缓冲区 — 用于分类器的 text-repeat 检测 */
  private ngramBuffer: string[] = []

  /** 全局 Token 预算累计（跨输入队列、跨 run 持久于实例） */
  private runTotalTokens = 0

  /** 连续纯工具轮次计数 — 无文本输出的工具调用轮数，超过阈值强制收敛 */
  private consecutiveToolTurns = 0

  /** 同批次提取的记忆节点 id — 用于会话收尾时自动建边（co_occurred 共现） */
  private graphBatchIds: string[] = []

  /** 上次自动图谱维护时间戳 — 用于低频衰减/固化调度 */
  private lastGraphMaintenanceAt = 0

  /** 会话级 Token 四桶投影（对齐 dsh token-meter） */
  private tokenAccumulators = new Map<string, TokenUsageAccumulator>()

  get aborted(): boolean { return this.stateMachine.aborted }
  abort(): void { this.stateMachine.stop() }

  // ── 生命周期（对齐 dsh Agent：cancel/whenIdle/runMaintenance + agent/status） ──
  private _status: AgentStatus = "idle"
  private _cancelCause: string | null = null
  private _activeRuns = 0
  private _maintenanceActive = false
  private _abortController: AbortController | null = null
  private _idleWaiters: Array<() => void> = []

  /** Inbox 双边界投递队列（对齐 dsh：持久于 agent，跨 run 保留待办） */
  private inbox = new PendingInputQueue()
  /** 最近一次 run 的 sessionID（inbox splice 持久化落库目标） */
  private _lastSessionID: string | null = null

  get status(): AgentStatus { return this._status }
  get cancelCause(): string | null { return this._cancelCause }

  /**
   * 取消当前活动（对齐 dsh Agent.cancel）：
   * 中断正在运行的 turn 并触发 agent 停止；keepInbox 保留 pending 输入供下次 run。
   * 无活动时为空操作（不武装后续工作）。
   */
  cancel(cause: string | { kind?: string; reason?: string }, options?: { keepInbox?: boolean }): void {
    if (this._activeRuns === 0) return
    this._cancelCause = typeof cause === "string" ? cause : (cause.reason ?? cause.kind ?? "cancelled")
    // keepInbox=false（默认）丢弃 pending 待办；true 保留供下次 run
    if (!(options?.keepInbox ?? false)) this.inbox.clear()
    this._abortController?.abort(this._cancelCause)
    this.stateMachine.stop()
  }

  /** 追加独立回合（next-turn 队尾），返回入队项 */
  followup(message: string, type: InputType = "user"): QueueItem {
    const item = this.inbox.followup({ message, type })
    this._publishInboxEvent("agent/inbox/inserted", { boundary: item.boundary, item })
    return item
  }

  /** 插队干预（next-step 最前，当前步骤优先） */
  steer(message: string, type: InputType = "steer"): QueueItem {
    const item = this.inbox.steer({ message, type })
    this._publishInboxEvent("agent/inbox/inserted", { boundary: item.boundary, item })
    return item
  }

  /** 安静投递：入队但不唤醒（调用方负责不驱动 run） */
  inject(message: string, boundary: InboxBoundary = "next-turn"): QueueItem {
    const item = this.inbox.inject({ message, type: boundary === "next-step" ? "steer" : "user" }, boundary)
    this._publishInboxEvent("agent/inbox/inserted", { boundary: item.boundary, item })
    return item
  }

  /** 按身份丢弃一个待办 */
  discard(id: string): boolean {
    const found = this.inbox.peek().find(i => i.id === id)
    const ok = this.inbox.discard(id)
    if (ok && found) this._publishInboxEvent("agent/inbox/discarded", { item: found })
    return ok
  }

  /** 待办快照（step 优先） */
  pendingItems(): QueueItem[] {
    return this.inbox.peek()
  }

  /** 静默等待：解析于当前/后续 driver 工作到达静默后（无活动则立即解析）。 */
  whenIdle(): Promise<void> {
    if (this._activeRuns === 0) return Promise.resolve()
    return new Promise((resolve) => this._idleWaiters.push(resolve))
  }

  /**
   * 从真空闲相位运行一个后台维护任务（对齐 dsh Agent.runMaintenance）：
   * turn-driving 或另一维护任务已占用 agent 时同步抛错；任务信号随 cancel 中止。
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this._activeRuns > 0 || this._maintenanceActive) {
      throw new Error("agent is busy (turn-driving or another maintenance task owns the agent)")
    }
    this._maintenanceActive = true
    const signal = this._abortController?.signal ?? new AbortController().signal
    return (async () => {
      try { return await task(signal) }
      finally { this._maintenanceActive = false }
    })()
  }

  private _beginRun(): void {
    this._activeRuns++
    this._abortController = new AbortController()
    this._cancelCause = null
    this._wireInbox()
    this._setStatus("running")
  }

  private _wireInbox(): void {
    if (this.inbox.onSplice) return
    this.inbox.onSplice = (op, kind) => this._onInboxSplice(op, kind)
  }

  /** Inbox 变更：发 splice 操作流事件 + 落 session_events（可回放） */
  private _onInboxSplice(op: InboxSpliceOp, kind: InboxSpliceKind): void {
    const ops = [{
      op: op.op,
      boundary: op.boundary,
      index: op.index,
      ...(op.op === "insert" ? { item: { message: op.item.message, type: op.item.type } } : {}),
    }]
    this._publishInboxEvent("agent/inbox/spliced", { ops })
    if (this._lastSessionID) {
      Promise.all([
        import("../session/event-types"),
        import("../session/event-store"),
      ]).then(([{ createInboxSplicedEvent }, { getEventStore }]) => {
        if (this._lastSessionID) {
          return getEventStore().append(createInboxSplicedEvent(this._lastSessionID, { ops }))
        }
      }).catch(() => { /* 持久化失败不阻塞投递 */ })
    }
  }

  /** 经 scope-target 载体广播 inbox 事件（与 agent/created 等一致：global listener 接收） */
  private _publishInboxEvent(name: string, payload: object): void {
    const events = (this.agentCtx ?? this.miraCtx)?.events
    if (!events) return
    const carrier = scopeTarget(this, this)
    const args: unknown[] = [carrier, name, { agent: this, ...payload }]
    try {
      for (const callback of events.dispatch("emit", args)) {
        void Promise.resolve(callback(...args)).catch((error: unknown) => {
          this.miraCtx?.logger.warn(`agent "${this.id}": ${name} listener rejected: ${String(error)}`)
        })
      }
    } catch (error: unknown) {
      this.miraCtx?.logger.warn(`agent "${this.id}": ${name} listener threw: ${String(error)}`)
    }
  }

  private _endRun(): void {
    this._activeRuns--
    this._abortController = null
    if (this._activeRuns === 0) {
      this._setStatus("idle")
      const waiters = this._idleWaiters
      this._idleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private _setStatus(next: AgentStatus): void {
    if (this._status === next) return
    this._status = next
    this._publishStatus(next)
  }

  /** 经 scope-target 载体广播 agent/status（与 agent/created 等一致：global listener 接收） */
  private _publishStatus(status: AgentStatus): void {
    const events = (this.agentCtx ?? this.miraCtx)?.events
    if (!events) return
    const carrier = scopeTarget(this, this)
    const args: unknown[] = [carrier, "agent/status", { agent: this, status }]
    try {
      for (const callback of events.dispatch("emit", args)) {
        void Promise.resolve(callback(...args)).catch((error: unknown) => {
          this.miraCtx?.logger.warn(`agent "${this.id}": agent/status listener rejected: ${String(error)}`)
        })
      }
    } catch (error: unknown) {
      this.miraCtx?.logger.warn(`agent "${this.id}": agent/status listener threw: ${String(error)}`)
    }
  }

  private ensureVectorProvider(): VectorMemoryProvider {
    if (!this._vectorProvider) {
      this._vectorProvider = new VectorMemoryProvider()
      this.memoryManager.addProvider(this._vectorProvider)
    }
    return this._vectorProvider
  }

  constructor(
    private registry: ToolRegistry,
    apiKey?: string,
    apiUrl?: string,
    workspace?: string,
    private deps?: {
      memoryManager?: MemoryManager
      checkpointProvider?: CheckpointProvider
      dreamDistillManager?: DreamDistillManager
      contextManager?: ContextManager
      goalJudge?: GoalJudge
      orchestrator?: ToolOrchestrator
      ftsProvider?: FTSMemoryProvider
      /** Cordis Context（可选）：注入后 Agent 循环可被插件扩展（agent/pre-step 等事件） */
      cordisCtx?: MiraContext
      /** 作用域 id（=sessionID）：ctx.agents 注册身份 */
      id?: string
      /** agent 作用域上下文（createScope 铸造，owner 经 ctx.agent 读取） */
      agentCtx?: MiraContext
    },
  ) {
    this.memoryManager = deps?.memoryManager ?? new MemoryManager()
    this.miraCtx = deps?.cordisCtx ?? null
    this.id = deps?.id
    this.agentCtx = deps?.agentCtx
    this.dynamicMemory = createDynamicMemory()
    setDynamicMemoryManager(this.dynamicMemory)
    this.checkpointProvider = deps?.checkpointProvider ?? new CheckpointProvider()
    this.dreamDistillManager = deps?.dreamDistillManager ?? new DreamDistillManager()
    this.contextManager = deps?.contextManager ?? new ContextManager(this.checkpointProvider, this.memoryManager)
    this.goalJudge = deps?.goalJudge ?? new GoalJudge()
    this.approvalStore = new ApprovalStore()
    this.orchestrator = deps?.orchestrator ?? new ToolOrchestrator(
      registry,
      workspace ? { persistDir: join(workspace, ".task_outputs", "tool-results") } : undefined,
    )
    const ftsProvider = deps?.ftsProvider ?? new FTSMemoryProvider()
    this.memoryManager.addProvider(new BuiltinMemoryProvider())
    this.memoryManager.addProvider(this.checkpointProvider)
    if (workspace) {
      this.memoryManager.addProvider(new FileMemoryProvider())
      this.memoryManager.addProvider(ftsProvider)
    }
    this.checkpointProvider.setFTSProvider(ftsProvider)
    setFTSProvider(ftsProvider)

    // 注册默认 stop hooks
    registerStopHook(autoDreamHook)
    registerStopHook(memoryPromoteHook)
  }

  getGoalJudge(): GoalJudge { return this.goalJudge }
  getContextManager(): ContextManager { return this.contextManager }
  getSourceManager(): SourceManager | null { return this.sourceManager }
  getFTSProvider() { return this.memoryManager.getFTSProvider() }

  /** 注入 Cordis Context（AgentLoop 服务装配时调用），启用循环插件扩展点 */
  setMiraContext(ctx: MiraContext | null): void {
    this.miraCtx = ctx
  }

  /**
   * 附加作用域身份（MiraAgentLoop 创建时调用）：
   * 设置 id（=sessionID）与 agent 作用域 ctx，并把本 Agent 挂到 agentCtx.agent。
   */
  attachScope(id: string, agentCtx: MiraContext): void {
    this.id = id
    this.agentCtx = agentCtx.extend({ agent: this })
  }

  /** 获取已注入的 Cordis Context */
  getMiraContext(): MiraContext | null {
    return this.miraCtx
  }

  replyPermission(id: string, reply: PermissionReply): void {
    this.stateMachine.replyPermission(id, reply)
  }

  /* ════════════════════════════════════════════════
     阶段拆分 — run 方法拆为 5 个阶段
     1. prepare     → 初始化所有管理器 + 工具集
     2. restore     → 会话恢复（从 DB 重建上下文）
     3. buildPrompt → 系统提示构建 + 消息列表组装
     4. executeLoop → 两层循环（外层输入队列/内层推理-行动）
     5. finalize    → stop hooks + 清理
     ════════════════════════════════════════════════ */

  // 5 个阶段（prepare/restore/buildMessages/handleTurn/finalize）已拆分为独立
  // 模块 agent/stages.ts，_runCore 直接调用 stages 函数（AgentInternals 依赖接口）

  async *run(
    userMessage: string,
    history: LLMMessage[],
    config: AgentConfig,
    images?: string[],
    files?: FileRef[],
  ): AsyncGenerator<AgentEvent> {
    this._beginRun()
    try {
      yield* this._runCore(userMessage, history, config, images, files)
    } finally {
      // 无论正常结束、中断、abort 或异常，都确保清理
      this._endRun()
    }
  }

  private async *_runCore(
    userMessage: string,
    history: LLMMessage[],
    config: AgentConfig,
    images?: string[],
    files?: FileRef[],
  ): AsyncGenerator<AgentEvent> {
    const perfStart = Date.now()
    const { ctx, toolSet, llmConfig, maxSteps } = await prepareRun(this, config)
    logInfo("Perf", `agent.run prepareRun ${Date.now() - perfStart}ms`)
    // 图片传递诊断：确认渲染进程是否把图片 data URL 传入 agent
    if (images && images.length > 0) {
      logInfo("Image", `agent.run received ${images.length} image(s), first=${images[0]?.slice(0, 60)}...`)
    } else {
      logInfo("Image", "agent.run received NO images")
    }

    if (this.dreamDistillManager && this.contextManager.shouldAutoDream?.()) {
      try {
        this.dreamDistillManager.setLLMConfig({ apiKey: config.apiKey, apiUrl: config.apiUrl, model: config.model, provider: config.provider || "openai" })
        await this.dreamDistillManager.autoDream()
        yield { type: "thinking", text: "🧠 Memory consolidated from recent session" }
      } catch { /* 不阻塞 */ }
    }

    const restoredHistory = await restoreSession(this, history, config)
    logInfo("Perf", `agent.run restoreSession ${Date.now() - perfStart}ms`)

    // 图片落盘：写入 {userData}/attachments/{sessionId}/，返回相对路径供落库与历史恢复
    let imagePaths: string[] | undefined
    if (images && images.length > 0) {
      imagePaths = await persistUploadedImages(config.sessionID, images)
    }

    // 文件（文本/Office）：文本存路径提示（Agent 用 read_file）；Office 解析注入一次性
    const fileRefs = files
    let fileInjectedText = ""
    if (files && files.length > 0) {
      const { parseOfficeFileForModel } = await import("../llm/ooxml-core")
      const officeTexts: string[] = []
      for (const f of files) {
        if (!f.path) continue
        if (f.kind === "excel" || f.kind === "word" || f.kind === "ppt") {
          const content = await parseOfficeFileForModel(f.path, f.name)
          if (content) officeTexts.push(`### ${f.name}\n\n${content}`)
          else officeTexts.push(`📎 ${f.name} (${f.path})`)
        } else {
          // 文本/未知/任意文件：给路径提示，Agent 通过 read_file 读取
          officeTexts.push(`📎 ${f.name} (${f.path})`)
        }
      }
      if (officeTexts.length > 0) {
        fileInjectedText = `\n\n${officeTexts.join("\n\n")}`
      }
    }

    const { enrichedUser, memoryPrompt } = await this.contextManager.prepareContext(userMessage + fileInjectedText, config.sessionID)
    logInfo("Perf", `agent.run prepareContext ${Date.now() - perfStart}ms`)
    let messages = await buildMessages(this, config, userMessage, enrichedUser, memoryPrompt, restoredHistory, imagePaths, fileRefs)
    logInfo("Perf", `agent.run buildMessages ${Date.now() - perfStart}ms`)

    // 用户上传的图片：注入首条 user 消息为 ImagePart（含图片时模型才能识图）
    if (images && images.length > 0) {
      const lastUserIdx = messages.findLastIndex((m) => m.role === "user")
      if (lastUserIdx >= 0) {
        logInfo("Image", `injecting ${images.length} image part(s) into user message idx=${lastUserIdx}`)
        const baseContent = messages[lastUserIdx].content
        const textContent = typeof baseContent === "string"
          ? baseContent
          : baseContent.filter((p) => p.type === "text").map((p) => (p as { text?: string }).text || "").join("\n")
        messages[lastUserIdx] = {
          ...messages[lastUserIdx],
          content: [
            { type: "text" as const, text: textContent },
            ...images.map((img) => {
              // img 为完整 data URL（data:image/png;base64,...），由协议层序列化为 image_url
              const mime = /^data:(image\/[a-z0-9.+-]+);/.exec(img)?.[1] || "image/png"
              return { type: "image" as const, image: img, mediaType: mime }
            }),
          ],
        }
      }
    }

    // 用户消息入队（inbox 持久于 agent：cancel keepInbox 保留的待办自动衔接）
    this._lastSessionID = config.sessionID
    this.inbox.followup({ message: userMessage, type: "user" })

    let turnIndex = 0

    while (this.inbox.hasPending()) {
      const currentInput = this.inbox.claim()!
      this._publishInboxEvent("agent/inbox/claimed", { boundary: currentInput.boundary, item: currentInput })
      turnIndex++
      const isFirstInput = currentInput.message === userMessage
      if (!isFirstInput) {
        messages.push({ role: "user", content: currentInput.message })
        await appendMessage(config.sessionID, { role: "user", content: currentInput.message, timestamp: new Date().toISOString() })
      }

      let step = 0
      let hasLastAssistant = false
      const allToolCalls: Array<{ name: string; args: string }> = []
      this.consecutiveToolTurns = 0
      // 全局 Token 预算累计（跨输入队列）
      const maxTotalTokens = config.maxTotalTokens || 0
      let totalTokensUsed = this.runTotalTokens
      const budgetCheckpointAt = Math.floor(maxTotalTokens * 0.8)

      while (true) {
        step++

        if (step === maxSteps - 1) {
          // 最后一轮前注入警告，本轮正常调用 LLM（不再 continue 浪费一轮）
          yield { type: "thinking", text: "⚠️ 已达步数上限，LLM 正在做总结..." }
          messages.push({ role: "user", content: MAX_STEPS_WARNING })
        } else if (step >= maxSteps) {
          yield { type: "thinking", text: "⛔ 超出步数上限，强制总结..." }
          messages.push({ role: "user", content: MAX_STEPS_REACHED })
        }

        if (hasLastAssistant) {
          const stepAction = classifyStep(messages, {
            step, maxSteps, ngramBuffer: this.ngramBuffer,
            activeGoal: this.goalJudge.getActiveGoal(), toolErrorCount: 0,
            toolCallCount: messages.filter(m => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool-call")).length,
            userIntent: detectUserIntent(currentInput.message),
          })
          if (isTerminal(stepAction)) break
          if (isRecovery(stepAction)) {
            yield { type: "thinking", text: getNudgeMessage(stepAction) }
            messages.push({ role: "user", content: stepAction.nudge })
            continue
          }
        }

        if (this.stateMachine.aborted) {
          yield { type: "finish", reason: "stopped" }
          return
        }

        const { messages: rebuiltMessages, didRebuild, reason } = await this.contextManager.checkAndRebuild(messages, config.sessionID)
        if (didRebuild) {
          messages = rebuiltMessages
          const tokensAfter = estimateTokens(messages)
          yield { type: "context_rebuild", reason, tokensBefore: 0, tokensAfter }
        }

        // 记忆注入（原有 pre_llm 链路，保持持久化语义：注入结果写回 messages 参与历史）
        if (config.sessionID && config.workspace) {
          const tMem = Date.now()
          messages = await this.contextManager.injectMemories(messages, config.sessionID)
          const memMs = Date.now() - tMem
          const tGraph = Date.now()
          messages = await injectGraphMemoryStage(this, messages)
          logInfo("Perf", `pre_llm injectMemories ${memMs}ms injectGraphMemory ${Date.now() - tGraph}ms`)
        }

        // Cordis 类型化扩展点：agent/request（waterfall，原 pre_llm 槽位）拦截/改写模型请求
        if (this.miraCtx) {
          const request = { messages, config }
          const out = await this.miraCtx.waterfall("agent/request", request, () => request as never)
          if (out && out.messages) messages = out.messages
        }

        // Cordis 类型化扩展点：agent/pre-step（waterfall）决定模型所见
        // 插件可在此重写消息、注入 prompt 段或拒绝输入（调用 next() 继续）
        if (this.miraCtx) {
          const preStep = await this.miraCtx.waterfall("agent/pre-step", messages, () => messages as never)
          if (preStep) messages = preStep
        }

        for (const m of messages) {
          if (Array.isArray(m.content)) {
            for (const p of m.content) {
              if (p.type === "tool-call") allToolCalls.push({ name: p.toolName, args: JSON.stringify(p.args) })
            }
          }
        }

        const turnInput: TurnRunnerInput = {
          messages, tools: toolSet, sessionID: config.sessionID, workspace: config.workspace,
          config: { ...llmConfig, maxContextTokens: config.maxContextTokens, permissions: config.permissions, onPermissionSave: config.onPermissionSave, autoAcceptPermissions: config.autoAcceptPermissions, fallbacks: config.fallbacks, visionModel: config.visionModel, modelVision: config.modelVision },
          deps: { registry: this.registry, stateMachine: this.stateMachine, approvalStore: this.approvalStore, orchestrator: this.orchestrator, cordisCtx: this.miraCtx ?? undefined },
          signal: this._abortController?.signal,
          ctx,
          // 最后一步禁用所有工具定义，强制纯文本收尾（参考 OpenCode MAX_STEPS_PROMPT）
          ...(step >= maxSteps ? { tools: {} } : {}),
        }

        const turnOutput = config.maxMode
          ? yield* runMaxModeTurn({ ...turnInput, maxModeConfig: { n: config.maxModeCandidates || 3, candidateConfig: llmConfig, judgeConfig: config.judgeModelConfig } })
          : yield* runTurn(turnInput)

        const { messages: newMessages, shouldContinue } = yield* handleTurn(this, turnOutput, messages, config, currentInput, allToolCalls)
        messages = newMessages
        if (!shouldContinue) return

        // ── 成本/用量累加到会话（参考 opencode Session.Info.cost/tokens） ──
        if (turnOutput.usage) {
          const pricing = getModelPricing(config.model)
          const result = calculateCost(turnOutput.usage, pricing)

          // 会话级四桶投影（uncachedInput/output/cacheRead/cacheWrite）
          const accumulator = this.tokenAccumulators.get(config.sessionID)
            ?? (this.tokenAccumulators.set(config.sessionID, new TokenUsageAccumulator()).get(config.sessionID)!)
          const proj = accumulator.add({ turn: turnIndex, step, usage: turnOutput.usage })

          // 注入 provider 实测 prompt 占用（校准压缩决策）
          this.contextManager.setProviderTokens(turnOutput.usage.promptTokens || 0)

          // 缓存命中率诊断日志（投影桶）
          const totalInput = proj.uncachedInputTokens + proj.cacheReadTokens + proj.cacheWriteTokens
          if (proj.cacheReadTokens > 0 || proj.cacheWriteTokens > 0) {
            const hitRate = totalInput > 0
              ? (proj.cacheReadTokens / totalInput * 100).toFixed(1)
              : "0"
            logInfo("Cache", `hit=${proj.cacheReadTokens} write=${proj.cacheWriteTokens} uncached=${proj.uncachedInputTokens} hitRate=${hitRate}% model=${config.model}`)
          }

          const { accumulateSessionUsage } = await import("../session/manager")
          await accumulateSessionUsage(config.sessionID, {
            cost: result.cost,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            reasoningTokens: result.reasoningTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheWriteTokens: result.cacheWriteTokens,
          })
        }

        // ── 全局 Token 预算闸门 ──
        if (turnOutput.usage?.totalTokens) {
          totalTokensUsed += turnOutput.usage.totalTokens
          this.runTotalTokens = totalTokensUsed
          if (maxTotalTokens > 0 && totalTokensUsed >= maxTotalTokens) {
            yield { type: "thinking", text: `⛔ Token 预算已耗尽（${totalTokensUsed}/${maxTotalTokens}），强制总结并终止...` }
            messages.push({ role: "user", content: MAX_STEPS_REACHED })
          } else if (maxTotalTokens > 0 && totalTokensUsed >= budgetCheckpointAt) {
            yield { type: "thinking", text: `⚠️ Token 预算已使用 ${Math.round((totalTokensUsed / maxTotalTokens) * 100)}%（${totalTokensUsed}/${maxTotalTokens}），请尽快收尾...` }
          }
        }

        await this.contextManager.syncTurn(currentInput.message, turnOutput.text, config.sessionID)
        await this.memoryManager.promoteMemories(config.sessionID)
        this.dreamDistillManager.recordTurn(currentInput.message, turnOutput.text)

        if (turnOutput.text) {
          this.ngramBuffer.push(turnOutput.text)
          if (this.ngramBuffer.length > 20) this.ngramBuffer.shift()
        }

        if (config.apiKey && !this.checkpointProvider.hasLLMConfig) {
          this.contextManager.setLLMConfig({ apiKey: config.apiKey, apiUrl: config.apiUrl, model: config.model, provider: config.provider || "openai" })
        }

        hasLastAssistant = true
      }

      const stopResult = await runStopHooks({ sessionID: config.sessionID, workspace: config.workspace, messages, contextManager: this.contextManager, memoryManager: this.memoryManager, dreamDistillManager: this.dreamDistillManager })
      if (stopResult.additionalMessages.length > 0) {
        this.inbox.pushMany(stopResult.additionalMessages.map(msg => ({ message: msg, type: "steer" as const })))
      }
    }

    await finalizeRun(this, config)
    yield { type: "finish", reason: "length" }
  }
}

/* ── 辅助函数 ── */

/** 解析 user 消息 JSON {text, images:[paths]}，非此格式返回 null */
function getNudgeMessage(action: { type: string; nudge?: string; reason?: string }): string {
  if (action.type === "retry") return "🔄 正在修正回答..."
  if (action.type === "text-repeat") return "🔁 检测到重复输出，正在尝试不同方式..."
  if (action.type === "auto-continue") return `⏩ 自动续跑中 (${(action as any).reason || ""})...`
  return "⏳ 处理中..."
}

/**
 * 检测用户意图：区分"纯聊天"与"需要工具"。
 * - 简单寒暄/概念问答 → chat_only（不应误调工具）
 * - 涉及文件/代码/数据/网络 → requires_tool
 * 参考 kimi.txt:7 的问答-任务区分逻辑。
 */
function detectUserIntent(message: string): "requires_tool" | "chat_only" | undefined {
  if (!message) return undefined
  const text = message.trim()
  const chatOnlyPatterns = [
    /^(你好|嗨|hi|hello|哈喽|早上好|下午好|晚上好|谢谢|再见|拜拜|在吗|你是谁|你能做什么|介绍一下你自己)\s*[!！。.]*$/i,
  ]
  if (chatOnlyPatterns.some(p => p.test(text))) return "chat_only"

  // 明确需要工具的迹象
  const toolIndicators = [
    /(读|查|看|打开|修改|编辑|创建|写|删除|搜索|找|统计|分析|比较|运行|执行|安装|下载|检查|测试|部署|构建|打包|git|npm|python|node|文件|目录|代码|报错|错误|日志|数据库|接口|api|url|网页|新闻|数据)/i,
  ]
  if (toolIndicators.some(p => p.test(text))) return "requires_tool"

  // 抽象概念问答（如"什么是递归"）→ 需要工具但可能只是解释
  return undefined
}
