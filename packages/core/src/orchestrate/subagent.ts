import { randomUUID } from "crypto"
import { Agent } from "../agent/agent"
import type { AgentConfig, AgentEvent } from "../agent/agent"
import type { ToolRegistry } from "../system/registry"
import { getDbAsync, runWrite } from "../system/database"
import type { LLMMessage } from "../llm/client"
import { logError } from "../system/logger"
import { sendMessage } from "./team-bus"
import { injectReturnFormat } from "./actor-protocol"
import { TaskGate } from "./actor-gate"
import { createScope } from "../scope/index"
import type { Context as MiraContext } from "../vendor/cordis/index"
import * as fs from "fs/promises"
import * as path from "path"

export type SubagentStatus = "pending" | "running" | "completing" | "completed" | "failed" | "cancelled" | "orphaned" | "stuck"
export type ContextMode = "none" | "state" | "full"
export type AgentMode = "subagent" | "peer"

export interface SubagentInfo {
  id: string
  sessionId: string
  parentId: string | null
  description: string
  status: SubagentStatus
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  result: string | null
  error: string | null
  contextMode: ContextMode
  turnCount: number
  mode: AgentMode
}

export type SubagentEventType = "created" | "started" | "completing" | "completed" | "failed" | "cancelled" | "stuck"

export interface SubagentEvent {
  type: SubagentEventType
  subagentId: string
  timestamp: string
  info: SubagentInfo
  parentEvent?: AgentEvent
}

interface SubagentSession {
  info: SubagentInfo
  agent: Agent
  abortController: AbortController
  events: AgentEvent[]
  promise: Promise<SubagentInfo> | null
  lastActivity: number
  preStopCount: number
  postStopCount: number
  peerWorkspace?: string
  /** ctx.agents 注销 disposer（enter 返回；完成后移除实时条目） */
  detachRegistry?: () => void
  /** 子 agent 作用域释放（async） */
  disposeScope?: () => Promise<void>
}

/** 并发配置 */
const MAX_PARALLEL = Number(process.env.MIRA_MAX_PARALLEL_AGENTS) || 5
const MAX_DEPTH = Number(process.env.MIRA_MAX_AGENT_DEPTH) || 8
const MAX_LIFECYCLE = Number(process.env.MIRA_MAX_LIFECYCLE_AGENTS) || 100
const STUCK_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟
const STUCK_CHECK_INTERVAL_MS = 60 * 1000 // 每分钟扫描
const REACT_MAX_ROUNDS = 3

/** 子 Agent 默认禁用的工具（权限派生，对齐 opencode）：防无限递归嵌套 */
const CHILD_DENY_TOOLS = new Set(["spawn_agent", "todo_tool", "workflow_run"])

/** 计算子 Agent 的工具白名单：父白名单（或全量）减去 CHILD_DENY_TOOLS */
function childToolAllowlist(config: AgentConfig, registry: ToolRegistry): string[] {
  const base = config.toolAllowlist || registry.getAll().map((t) => t.name)
  return base.filter((t) => !CHILD_DENY_TOOLS.has(t))
}

export class SubagentManager {
  private sessions = new Map<string, SubagentSession>()
  private registry: ToolRegistry
  private onEventCallback: ((event: SubagentEvent) => void) | null = null
  private maxParallel = MAX_PARALLEL
  private pendingQueue: Array<() => void> = []
  private gate = new TaskGate()
  private stuckTimer: ReturnType<typeof setInterval> | null = null
  /** Cordis Context（可选注入）：子 Agent 同步发布进 ctx.agents 实时注册表 */
  private miraCtx: MiraContext | null = null

  constructor(registry: ToolRegistry, options?: { maxParallel?: number }) {
    this.registry = registry
    if (options?.maxParallel) this.maxParallel = options.maxParallel
    this.recoverOrphans()
    this.startStuckDetection()
  }

  /** 注入 Cordis Context（sidecar 装配后调用），启用 ctx.agents 实时注册 */
  setCordisContext(ctx: MiraContext | null): void {
    this.miraCtx = ctx
  }

  /** 启动粘滞检测 */
  private startStuckDetection(): void {
    if (this.stuckTimer) return
    this.stuckTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, session] of this.sessions) {
        if (session.info.status === "running" && now - session.lastActivity > STUCK_TIMEOUT_MS) {
          session.info.status = "stuck"
          session.info.error = "No activity for 5 minutes"
          session.info.completedAt = new Date().toISOString()
          this.persistActor(session.info).catch(() => {})
          this.emitEvent("stuck", id)
          logError(`[SubagentManager] Subagent ${id} stuck (no activity for 5min)`)
        }
      }
    }, STUCK_CHECK_INTERVAL_MS)
  }

  /** 停止粘滞检测 */
  private stopStuckDetection(): void {
    if (this.stuckTimer) { clearInterval(this.stuckTimer); this.stuckTimer = null }
  }

  private async getDb() { return getDbAsync() }

  private async persistActor(info: SubagentInfo): Promise<void> {
    runWrite(
      `INSERT OR REPLACE INTO actor_registry
       (actor_id, session_id, parent_actor_id, mode, status, description, context_mode, result, error, turn_count, time_created, time_updated, time_completed, lifecycle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        info.id, info.sessionId, info.parentId || null, info.mode, info.status,
        info.description, info.contextMode, info.result, info.error, info.turnCount,
        info.createdAt, new Date().toISOString(), info.completedAt, info.mode === "peer" ? "persistent" : "ephemeral",
      ],
    )
  }

  private async recoverOrphans(): Promise<void> {
    try {
      runWrite(
        "UPDATE actor_registry SET status = 'orphaned', time_updated = datetime('now') WHERE status IN ('pending', 'running', 'completing')",
      )
    } catch { /* 首次运行无表 */ }
  }

  get activeCount(): number {
    return Array.from(this.sessions.values()).filter(s => s.info.status === "running").length
  }

  private getDepth(actorId: string): number {
    let depth = 0
    let current = actorId
    while (true) {
      const session = this.sessions.get(current)
      if (!session?.info.parentId) break
      current = session.info.parentId
      depth++
    }
    return depth
  }

  private async acquireSlot(depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error(`Agent nesting depth exceeds max (${MAX_DEPTH})`)
    if (this.sessions.size >= MAX_LIFECYCLE) throw new Error(`Total agent count exceeds max (${MAX_LIFECYCLE})`)
    while (this.activeCount >= this.maxParallel) {
      await new Promise<void>(resolve => this.pendingQueue.push(resolve))
    }
  }

  private releaseSlot(): void {
    const next = this.pendingQueue.shift()
    next?.()
  }

  onEvent(callback: (event: SubagentEvent) => void): void { this.onEventCallback = callback }
  getGate(): TaskGate { return this.gate }

  /**
   * 启动子 Agent
   * @param mode "subagent" — 共享父会话；"peer" — 独立会话+工作目录
   */
  spawn(
    description: string,
    config: AgentConfig,
    options?: {
      parentId?: string
      prompt?: string
      model?: string
      context?: ContextMode
      parentContext?: LLMMessage[]
      mode?: AgentMode
      /** JSON Schema：子 Agent 最终结果以该结构 JSON 输出（作为交付内容） */
      outputSchema?: Record<string, unknown>
    }
  ): SubagentInfo {
    const contextMode = options?.context || "none"
    const mode = options?.mode || "subagent"
    const id = `sub-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`

    const info: SubagentInfo = {
      id,
      sessionId: config.sessionID,
      parentId: options?.parentId || null,
      description,
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      contextMode,
      turnCount: 0,
      mode,
    }

    const agent = new Agent(this.registry, config.apiKey, config.apiUrl, config.workspace)
    const abortController = new AbortController()

    // Cordis 集成：子 Agent 同步发布进 ctx.agents（enter/announce，保持 spawn 同步）
    let detachRegistry: (() => void) | undefined
    let disposeScope: (() => Promise<void>) | undefined
    if (this.miraCtx) {
      const scope = createScope(this.miraCtx, { sessionId: id })
      disposeScope = scope.dispose
      agent.setMiraContext(this.miraCtx)
      agent.attachScope(id, scope.ctx)
      detachRegistry = this.miraCtx.agents?.enter(agent, this.miraCtx.agent)
      this.miraCtx.agents?.announce(agent)
    }

    const session: SubagentSession = {
      info, agent, abortController, events: [], promise: null,
      lastActivity: Date.now(), preStopCount: 0, postStopCount: 0,
      detachRegistry, disposeScope,
    }
    this.sessions.set(id, session)
    this.persistActor(info).catch(() => {})
    this.emitEvent("created", id)

    const depth = this.getDepth(id)
    const parentContext = options?.parentContext || []

    this.acquireSlot(depth).then(async () => {
      // Peer 模式：创建独立工作目录
      if (mode === "peer" && config.workspace) {
        const peerDir = path.join(config.workspace, ".mira", "peers", id)
        await fs.mkdir(peerDir, { recursive: true }).catch(() => {})
        session.peerWorkspace = peerDir
      }

      // 结构化输出：提供 outputSchema 时，要求子 Agent 最终结果以 JSON 输出
      let basePrompt = options?.prompt || description
      if (options?.outputSchema) {
        basePrompt = `${basePrompt}\n\n请将最终结果以 JSON 输出，结构如下（作为交付内容，请确保可被 JSON.parse 解析）：\n${JSON.stringify(options.outputSchema, null, 2)}\n\n（请先用 **Status**/**Summary** 标注执行状态，随后给出 JSON 交付内容）`
      }

      session.promise = this.runSubagent(session, config, basePrompt, id, parentContext, depth)
        .then((result) => {
          if (result.status === "completed" && result.result) {
            const decision = this.gate.decide(id, result.result)
            if (decision.status === "success") return result
            if (decision.status === "partial" && decision.feedback) {
              return this.retryWithFeedback(session, config, id, decision.feedback, parentContext, depth)
            }
            result.status = decision.status === "blocked" ? "failed" : "completed"
          }
          return result
        })
        .catch((err) => {
          info.status = "failed"; info.error = String(err)
          info.completedAt = new Date().toISOString()
          this.persistActor(info).catch(() => {})
          this.emitEvent("failed", id)
          logError(`[SubagentManager] Subagent ${id} failed`, err)
          return info
        })
        .finally(() => {
          // 从 ctx.agents 注销 + 释放子 agent 作用域
          session.detachRegistry?.()
          void session.disposeScope?.()
          // Peer 模式清理
          if (session.peerWorkspace) {
            fs.rm(session.peerWorkspace, { recursive: true, force: true }).catch(() => {})
          }
          this.releaseSlot()
        })
    })

    return info
  }

  /** 门控反馈后重新运行 */
  private async retryWithFeedback(
    session: SubagentSession, config: AgentConfig, id: string,
    feedback: string, parentContext: LLMMessage[], depth: number,
  ): Promise<SubagentInfo> {
    return this.runSubagent(session, config, feedback, id, parentContext, depth)
  }

  /** 运行子 Agent（含 ReAct preStop 循环） */
  private async runSubagent(
    session: SubagentSession, config: AgentConfig,
    prompt: string, id: string, parentContext: LLMMessage[], depth: number,
  ): Promise<SubagentInfo> {
    const { info, agent, abortController } = session

    info.status = "running"
    info.startedAt = new Date().toISOString()
    session.lastActivity = Date.now()
    this.persistActor(info).catch(() => {})
    this.emitEvent("started", id)

    // 注入标准化返回协议
    let finalPrompt = injectReturnFormat(prompt)

    try {
      let finalText = ""
      const events: AgentEvent[] = []

      for await (const event of agent.run(finalPrompt, parentContext, {
        ...config,
        sessionID: `${config.sessionID}-${info.id}`,
        agent: info.id,
        toolAllowlist: childToolAllowlist(config, this.registry),
      })) {
        session.lastActivity = Date.now()

        if (abortController.signal.aborted) {
          info.status = "cancelled"
          info.completedAt = new Date().toISOString()
          this.persistActor(info).catch(() => {})
          this.emitEvent("cancelled", id)
          return info
        }

        events.push(event)
        if (event.type === "content") finalText += event.text
        else if (event.type === "error") {
          info.status = "failed"; info.error = event.message
          info.completedAt = new Date().toISOString()
          this.persistActor(info).catch(() => {})
          try { if (info.parentId) sendMessage(info.id, info.parentId, "notification", `[子 Agent 失败] ${info.description}\n\n${event.message}`) } catch {}
          this.emitEvent("failed", id)
          return info
        } else if (event.type === "finish") {
          info.status = "completing"
          this.emitEvent("completing", id)
        }
      }

      info.result = finalText
      info.turnCount++
      session.events = events

      // ── ReAct preStop 循环（最多 3 轮）──
      if (info.status === "completing" && session.preStopCount < REACT_MAX_ROUNDS) {
        session.preStopCount++
        // 检查是否需要额外轮次
        const needsExtraRound = this.checkPreStopHook(info, finalText)
        if (needsExtraRound) {
          finalPrompt = `继续上一轮工作。\n\n已完成: ${finalText.slice(0, 500)}\n\n请根据任务描述继续完成未完成的部分。`
          info.turnCount++
          this.persistActor(info).catch(() => {})
          // 重新进入循环
          for await (const event of agent.run(finalPrompt, parentContext, {
            ...config,
            sessionID: `${config.sessionID}-${info.id}`,
            agent: info.id,
            toolAllowlist: childToolAllowlist(config, this.registry),
          })) {
            session.lastActivity = Date.now()
            if (abortController.signal.aborted) {
              info.status = "cancelled"; info.completedAt = new Date().toISOString()
              this.persistActor(info).catch(() => {}); this.emitEvent("cancelled", id)
              return info
            }
            events.push(event)
            if (event.type === "content") finalText += event.text
            else if (event.type === "error") {
              info.status = "failed"; info.error = event.message
              info.completedAt = new Date().toISOString()
              this.persistActor(info).catch(() => {}); this.emitEvent("failed", id)
              return info
            }
          }
          info.result = finalText
          info.turnCount++
        }
      }

      // ── 完成 ──
      info.status = "completed"
      info.completedAt = new Date().toISOString()
      this.persistActor(info).catch(() => {})
      try {
        if (info.parentId) sendMessage(info.id, info.parentId, "result",
          `[子 Agent 完成] ${info.description}\n\n${(finalText || "").slice(0, 2000)}`)
      } catch {}

      this.emitEvent("completed", id)

      // ── ReAct postStop 循环（最多 3 轮）──
      if (session.postStopCount < REACT_MAX_ROUNDS) {
        session.postStopCount++
        await this.runPostStopHook(session, config, id, finalText, parentContext, depth)
      }

      return info
    } catch (err) {
      info.status = "failed"; info.error = String(err)
      info.completedAt = new Date().toISOString()
      this.persistActor(info).catch(() => {})
      this.emitEvent("failed", id)
      throw err
    }
  }

  /** preStop hook：检查是否需要额外轮次 */
  private checkPreStopHook(info: SubagentInfo, text: string): boolean {
    // 如果结果为空或者太短（<50 字符），说明可能没完成任务
    if (!text || text.trim().length < 50) return true
    // 如果结果中没有 Status 头，也需要继续
    if (!text.includes("**Status**")) return true
    return false
  }

  /** postStop hook：执行完成后的跟进工作 */
  private async runPostStopHook(
    session: SubagentSession, config: AgentConfig, id: string,
    result: string, parentContext: LLMMessage[], depth: number,
  ): Promise<void> {
    // 默认 postStop：将结果写入 peer 工作目录（如果是 peer 模式）
    if (session.peerWorkspace && result) {
      try {
        const statusPath = path.join(session.peerWorkspace, "RESULT.md")
        await fs.writeFile(statusPath, result, "utf-8")
      } catch {}
    }
  }

  async wait(id: string, timeoutMs = 300000): Promise<SubagentInfo> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Subagent not found: ${id}`)
    if (!session.promise) throw new Error(`Subagent ${id} not started`)
    const result = await Promise.race([
      session.promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])
    if (result === null) {
      session.info.status = "cancelled"
      session.abortController.abort()
      this.persistActor(session.info).catch(() => {})
      this.emitEvent("cancelled", id)
      return session.info
    }
    return result
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.abortController.abort()
    session.info.status = "cancelled"
    session.info.completedAt = new Date().toISOString()
    this.persistActor(session.info).catch(() => {})
    this.emitEvent("cancelled", id)
    this.cancelAllByParent(id)
    this.gate.cleanup(id)
    return true
  }

  getInfo(id: string): SubagentInfo | null { return this.sessions.get(id)?.info || null }
  getEvents(id: string): AgentEvent[] { return this.sessions.get(id)?.events || [] }

  list(filter?: { parentId?: string; status?: SubagentStatus }): SubagentInfo[] {
    let infos = Array.from(this.sessions.values()).map(s => s.info)
    if (filter?.parentId) infos = infos.filter(i => i.parentId === filter.parentId)
    if (filter?.status) infos = infos.filter(i => i.status === filter.status)
    return infos
  }

  listActive(): SubagentInfo[] {
    return [...this.list({ status: "running" }), ...this.list({ status: "pending" }), ...this.list({ status: "completing" })]
  }

  listByParent(parentId: string): SubagentInfo[] {
    const result: SubagentInfo[] = []
    const directChildren = this.list({ parentId })
    result.push(...directChildren)
    for (const child of directChildren) result.push(...this.listByParent(child.id))
    return result
  }

  cancelAllByParent(parentId: string): void {
    for (const child of this.list({ parentId })) {
      if (["running", "pending", "completing"].includes(child.status)) this.cancel(child.id)
    }
  }

  cancelAll(): void {
    for (const [id, session] of this.sessions) {
      if (["running", "pending", "completing"].includes(session.info.status)) this.cancel(id)
    }
  }

  spawnMany(tasks: Array<{
    description: string; config: AgentConfig
    options?: { parentId?: string; prompt?: string; model?: string; context?: ContextMode; parentContext?: LLMMessage[]; mode?: AgentMode }
  }>): SubagentInfo[] {
    return tasks.map((t) => this.spawn(t.description, t.config, t.options))
  }

  async waitAll(ids: string[], timeoutMs = 300000): Promise<SubagentInfo[]> {
    return Promise.all(ids.map((id) =>
      this.wait(id, timeoutMs).catch(() => this.getInfo(id) || {
        id, sessionId: "", parentId: null, description: "unknown",
        status: "failed" as SubagentStatus, createdAt: "", startedAt: null,
        completedAt: null, result: null, error: "timeout",
        contextMode: "none" as ContextMode, turnCount: 0, mode: "subagent" as AgentMode,
      }),
    ))
  }

  async waitAny(ids: string[], timeoutMs = 300000): Promise<SubagentInfo | null> {
    return Promise.race(ids.map((id) => this.wait(id, timeoutMs).catch(() => null as SubagentInfo | null)))
  }

  toText(): string {
    const lines: string[] = []
    const infos = Array.from(this.sessions.values()).map(s => s.info)
    const roots = infos.filter(i => !i.parentId)
    const children = new Map<string, SubagentInfo[]>()
    for (const info of infos) {
      if (info.parentId) {
        const list = children.get(info.parentId) || []
        list.push(info)
        children.set(info.parentId, list)
      }
    }
    const printTree = (info: SubagentInfo, indent = 0) => {
      const icon = { pending: "○", running: "●", completing: "◐", completed: "✓", failed: "✗", cancelled: "⊘", orphaned: "?", stuck: "⚠" }[info.status]
      lines.push(`${"  ".repeat(indent)}${icon} ${info.id}: ${info.description} [${info.status}]`)
      for (const kid of children.get(info.id) || []) printTree(kid, indent + 1)
    }
    for (const root of roots) printTree(root)
    return lines.join("\n")
  }

  toSystemPrompt(): string {
    const active = this.listActive()
    if (active.length === 0) return ""
    return [`[Active subagents]`, ...active.map(s => `- ${s.id}: ${s.description} (${s.status})`)].join("\n")
  }

  /** 释放资源 */
  dispose(): void {
    this.stopStuckDetection()
    this.cancelAll()
  }

  private emitEvent(type: SubagentEventType, subagentId: string): void {
    if (!this.onEventCallback) return
    const session = this.sessions.get(subagentId)
    if (!session) return
    this.onEventCallback({ type, subagentId, timestamp: new Date().toISOString(), info: session.info })
  }
}
