/**
 * Sidecar API 路由 — 将 Agent 操作暴露为 HTTP API
 * 参考 MiMo-Code 的 Sidecar 架构：Core 作为独立 HTTP 服务
 */

import { Agent, type AgentConfig, type AgentEvent, type PermissionReply } from "../../index"
import { createDefaultRegistry, defaultPermissions, PermissionSet, resolveRuntimeConfig, type PermissionRule } from "../../index"
import { DEFAULT_SYSTEM } from "../../agent/constants"
import { modeToPermissionSet, getModeConfig, getAllModes, getModeMaxIterations } from "../../config/modes"
import { getJsonSchema } from "../../shared/tool"
import { loadWorkspacePermissions, saveWorkspacePermission } from "../permission/store"
import { buildInstructionSystemPrompt } from "../instruction"
import { matchSkillCommand, buildSkillInvocationMessage } from "../../skill/skill-commands"
import { loadSkill } from "../../skill/skill-loader"
import { initDatabase, flushSave } from "../database"
import {
  listProjects,
  createProject,
  updateProject,
  deleteProjectById,
  createSession,
  listSessions,
  getSessionMessages,
  deleteSessionById,
  deleteSessionsById,
  deleteMessageById,
  searchMessages,
  updateSession,
  restoreSnapshot,
} from "../../session/manager"
import { AgentRegistry } from "../../agent/registry"
import { logError, logInfo } from "../logger"
import { taskTracker } from "../../task/tracker"
import { setParentConfig } from "../../tools/orchestrate/agent-tools"
import { setFTSProvider } from "../../tools/knowledge/memory"
import { loadSession } from "../../session/store"
import type { LLMMessage } from "../../llm/client"
import { generateFollowUpSuggestions } from "../../llm/follow-up"
import { FTSMemoryProvider } from "../../memory/fts-memory-provider"
import { loadGraph } from "../../memory/dynamic-memory-store"
import { SubagentManager, type SubagentStatus } from "../../orchestrate/subagent"
import { setSubagentManager } from "../../tools/orchestrate/agent-tools"
import { GoalJudge } from "../../orchestrate/goal-judge"
import type { TaskStatus } from "../../task/tracker"
import { answerQuestion, getPendingQuestions } from "../../tools/interaction/question"
import { StateGraph, GraphPersist } from "../../graph"
import { buildCodingTaskGraph, type CodingState } from "../../graph/templates/coding-task"
import type { GraphRunResult } from "../../graph/types"
import { createMiraContext } from "../../framework/services"
import { setupSelfModification, getDynamicPluginRunner } from "../../selfmod"
import type { Context as MiraContext } from "../../vendor/cordis/index"

// ── 初始化 ──────────────────────────────────────────

const registry = createDefaultRegistry()
const agentRegistry = new AgentRegistry()

/** 全局 Cordis Context（懒加载）：装配统一服务注册表 + 运行期自修改 */
let miraContext: MiraContext | null = null
async function getMiraContext(): Promise<MiraContext> {
  if (!miraContext) {
    // tools 复用共享 registry（createDefaultRegistry），让 mira_plugin_* 工具进入 Agent 工具集
    miraContext = await createMiraContext({ toolsRegistry: registry })
    // 运行期自修改：Agent 可在会话中定义/激活/卸载自己的插件
    setupSelfModification(miraContext)
    // 子 Agent 同步发布进 ctx.agents（SubagentManager 单例注入）
    if (subagentManager) subagentManager.setCordisContext(miraContext)
    logInfo("[mira] 全局 Cordis Context 已装配（含运行期自修改）")
  }
  return miraContext
}

// ── 运行期自修改 HTTP 端点（渲染进程/UI 拉取插件状态与 client 代码） ──

/** 列出会话内动态插件（供渲染进程展示状态） */
export function handleSelfmodListPlugins(body: { sessionId?: string }): { plugins: unknown[]; enabled: boolean } {
  const runner = getDynamicPluginRunner()
  if (!runner) return { plugins: [], enabled: false }
  const sessionId = body?.sessionId || "default"
  return { plugins: runner.list(sessionId), enabled: true }
}

/** 获取插件 client half 源码（渲染进程沙箱执行 UI 插件） */
export function handleSelfmodGetClientCode(
  body: { sessionId?: string; pluginId?: string; packageId?: string },
): { ok: boolean; clientCode?: string; error?: string } {
  const runner = getDynamicPluginRunner()
  if (!runner) return { ok: false, error: "运行期自修改未启用" }
  const sessionId = body?.sessionId || "default"
  const code = runner.getClientCode(sessionId, body?.pluginId as never, body?.packageId as never)
  if (code === undefined) return { ok: false, error: "client 代码不存在（该版本无 client half）" }
  return { ok: true, clientCode: code }
}

/** 运行期自修改是否启用 */
export function handleSelfmodStatus(): { enabled: boolean } {
  return { enabled: getDynamicPluginRunner() !== null }
}

for (const mode of getAllModes()) {
  agentRegistry.register({
    info: {
      name: mode.id,
      label: mode.label,
      description: mode.description,
      icon: mode.id === "plan" ? "search" : mode.id === "assistant" ? "brain" : mode.id === "expert" ? "zap" : mode.id === "action" ? "cpu" : "shield",
      maxIterations: mode.maxIterations,
      denyActions: mode.permissionRules.filter((r) => r.effect === "deny").map((r) => r.action),
    },
    async *run() {},
  })
}

initDatabase().catch((err) => logError("API 初始化失败", err))

// ── 共享 FTS 记忆单例 ────────────────────────────────
// 每个 Agent 复用同一 FTS 提供者（而非每轮新建重新加载 1.3GB 库）。
// 启动时不再预加载（避免阻塞 Sidecar），改为首次使用（对话/图谱/记忆搜索）时按需懒加载，
// 保证知识图谱重启后无需先发消息即可读取跨会话记忆。

let sharedMemoryFTS: FTSMemoryProvider | null = null
// 初始化 in-flight 去重：并发调用（如图谱加载 + 首次对话）共享同一 Promise，避免重复读取大库
let sharedMemoryFTSPromise: Promise<FTSMemoryProvider | null> | null = null

async function getRecentWorkspace(): Promise<string> {
  try {
    const db = await initDatabase()
    const rows = db.exec(
      "SELECT workspace_path FROM projects WHERE workspace_path IS NOT NULL AND workspace_path != '' ORDER BY created_at DESC LIMIT 1",
    )
    if (rows.length > 0 && rows[0].values.length > 0) return String(rows[0].values[0][0])
  } catch { /* 数据库未就绪时回退 */ }
  return process.cwd()
}

export async function ensureSharedMemoryFTS(preferredWorkspace?: string): Promise<FTSMemoryProvider | null> {
  if (sharedMemoryFTS) return sharedMemoryFTS
  if (!sharedMemoryFTSPromise) {
    sharedMemoryFTSPromise = (async () => {
      try {
        const ws = (preferredWorkspace && preferredWorkspace.trim()) || (await getRecentWorkspace())
        const fts = new FTSMemoryProvider()
        await fts.initialize("", ws)
        sharedMemoryFTS = fts
        setMemoryFTS(fts)
        setFTSProvider(fts)
        return fts
      } catch (err) {
        logError("[API] 初始化共享 FTS 记忆失败", err)
        return null
      }
    })()
  }
  return sharedMemoryFTSPromise
}

// 数据库初始化（sessions/projects 首屏必需）；共享 FTS 记忆改为首次 Agent 会话时懒加载，
// 避免启动阶段同步加载大型 fts-memory.db 阻塞 Sidecar 事件循环（见 ensureSharedMemoryFTS）
initDatabase().catch((err) => logError("数据库初始化失败", err))

// ── Agent 会话管理 ──────────────────────────────────

interface AgentSession {
  agent: Agent
  channel: string
  config: AgentConfig
  abortController: AbortController
}

const activeSessions = new Map<string, AgentSession>()

function generateChannelId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function buildPermissions(
  workspace: string,
  mode?: string,
  configOverride?: PermissionSet,
  hardRules?: PermissionRule[],
): Promise<PermissionSet> {
  const savedRules = await loadWorkspacePermissions(workspace)
  let base = defaultPermissions
  if (mode) {
    base = modeToPermissionSet(mode, defaultPermissions)
  }
  const configRules = configOverride?.getAll() || []
  // Permission 三明治：hardPermission 首尾各追加一次，确保硬规则不被覆盖
  const allRules = hardRules
    ? [...hardRules, ...base.getAll(), ...configRules, ...savedRules, ...hardRules]
    : [...base.getAll(), ...configRules, ...savedRules]
  return new PermissionSet(allRules)
}

function processSkillCommand(message: string): { processed: string; skillLoaded: boolean } {
  const result = matchSkillCommand(message)
  if (!result) return { processed: message, skillLoaded: false }
  if (loadSkill(result.name)) {
    const invocation = buildSkillInvocationMessage(result.name, result.rest)
    return { processed: invocation, skillLoaded: true }
  }
  return { processed: message, skillLoaded: false }
}

// ── API 处理函数 ────────────────────────────────────

export interface APIContext {
  writeEvent(data: unknown): void
  writeEnd(): void
  onAbort(callback: () => void): void
}

export async function handleStartStream(
  sessionId: string,
  message: string,
  config: Record<string, unknown>,
  ctx: APIContext,
  channel: string,
): Promise<void> {
  const workspace = (config.workspace as string) || process.cwd()
  // [SSE 卡点诊断] 记录 startStream 请求关键字段，定位 30s 无数据时的卡点
  logInfo(
    "[stream] handleStartStream begin",
    JSON.stringify({
      sessionId,
      provider: config.provider,
      model: config.model,
      mode: config.mode,
      imageCount: Array.isArray(config.images) ? config.images.length : 0,
      messageLen: message.length,
    }),
  )

  await taskTracker.initialize(sessionId)
  logInfo("[stream] taskTracker.initialize ok")

  const mergedConfig = resolveRuntimeConfig({
    provider: config.provider as string,
    model: config.model as string,
    apiKey: config.apiKey as string,
    apiUrl: config.apiUrl as string,
    headers: config.headers as Record<string, string> | undefined,
    options: config.options as Record<string, unknown> | undefined,
    mode: config.mode as string,
    workspace,
  })
  logInfo("[stream] resolveRuntimeConfig ok")

  const sharedFTS = await ensureSharedMemoryFTS(workspace)
  logInfo("[stream] ensureSharedMemoryFTS ok")
  const agent = new Agent(
    registry,
    mergedConfig.apiKey,
    mergedConfig.apiUrl,
    workspace,
    {
      ftsProvider: sharedFTS ?? undefined,
      // Cordis Context 注入：Agent 循环可被插件扩展（agent/pre-step 等）+ 运行期自修改工具
      cordisCtx: await getMiraContext(),
    },
  )
  logInfo("[stream] Agent created")
  // 将 FTS provider 注册到模块级单例（供 memory 工具和 HTTP 端点使用）
  const fts = agent.getFTSProvider()
  if (fts) {
    setFTSProvider(fts)
    setMemoryFTS(fts)
  }

  const { processed } = processSkillCommand(message)

  const hardRules = (config.hardPermission as any[] | undefined)?.map((r: any) => ({ action: r.action, resource: r.resource, effect: r.effect as "allow" | "deny" | "ask" }))
  const permissions = config.permissions
    ? new PermissionSet((config.permissions as any[]).map((r: any) => ({ action: r.action, resource: r.resource, effect: r.effect as "allow" | "deny" | "ask" })))
    : await buildPermissions(workspace, config.mode as string, undefined, hardRules)
  logInfo("[stream] permissions ok")

  const instructions = buildInstructionSystemPrompt(workspace)
  const baseSystem = (config.systemPrompt as string) || DEFAULT_SYSTEM
  const systemPrompt = instructions
    ? `[指令上下文]\n${instructions}\n\n[Agent 基础指令]\n${baseSystem}`
    : baseSystem

  const modeConfig = config.mode ? getModeConfig(config.mode as string) : null

  const effectiveConfig: AgentConfig = {
    sessionID: sessionId,
    workspace,
    model: mergedConfig.model,
    apiKey: mergedConfig.apiKey,
    apiUrl: mergedConfig.apiUrl,
    provider: mergedConfig.provider,
    headers: mergedConfig.headers,
    options: mergedConfig.options,
    systemPrompt,
    maxSteps: (config.maxSteps as number) || getModeMaxIterations(config.mode as string),
    maxContextTokens: config.maxContextTokens as number,
    permissions,
    mode: config.mode as any,
    toolAllowlist: modeConfig?.toolAllowlist,
    autoAcceptPermissions: config.autoAcceptPermissions as boolean,
    // 多模态视觉桥：主模型不支持 vision 时，图片交由此视觉模型描述（由前端推导传入）
    visionModel: config.visionModel as AgentConfig["visionModel"] | undefined,
    // 主模型是否支持直接识图（由前端按模型类型标记传入）
    modelVision: config.modelVision as boolean | undefined,
    onPermissionSave: (rules) => {
      for (const rule of rules) {
        saveWorkspacePermission(workspace, rule)
      }
    },
  }

  // 将 Agent 配置注入子 Agent 工具（让 spawn_agent 继承 apiKey/model 等）
  setParentConfig(effectiveConfig)

  const abortController = new AbortController()
  const session: AgentSession = { agent, channel, config: effectiveConfig, abortController }
  activeSessions.set(channel, session)

  ctx.onAbort(() => {
    agent.abort()
    activeSessions.delete(channel)
  })

  // 在后台运行 Agent 并通过 ctx 推送事件
  const images = Array.isArray(config.images) ? (config.images as string[]) : undefined
  const files = Array.isArray(config.files) ? (config.files as Array<{ name: string; path?: string; kind?: string }>) : undefined
  runAgentInBackground(session, sessionId, processed, effectiveConfig, ctx, images, files)
}

async function runAgentInBackground(
  session: AgentSession,
  sessionId: string,
  message: string,
  config: AgentConfig,
  ctx: APIContext,
  images?: string[],
  files?: Array<{ name: string; path?: string; kind?: string }>,
): Promise<void> {
  const { agent } = session
  try {
    for await (const evt of agent.run(message, [], { ...config, sessionID: sessionId }, images, files)) {
      ctx.writeEvent(evt)
    }
  } catch (e) {
    ctx.writeEvent({ type: "error", message: String(e) })
  } finally {
    ctx.writeEvent({ type: "finish", reason: "completed" })
    ctx.writeEnd()
    activeSessions.delete(session.channel)
    // 确保本轮消息可靠落盘（防抖持久化可能在进程退出前未触发）
    flushSave()
  }
}

export function handlePermissionReply(channel: string, requestId: string, reply: PermissionReply): boolean {
  const session = activeSessions.get(channel)
  if (!session) return false
  session.agent.replyPermission(requestId, reply)
  return true
}

export function handleStopStream(channel: string): boolean {
  const session = activeSessions.get(channel)
  if (!session) return false
  session.agent.abort()
  session.abortController.abort()
  activeSessions.delete(channel)
  return true
}

export function handleListTools(mode?: string): Array<{ name: string; description: string; parameters: any }> {
  const modeConfig = mode ? getModeConfig(mode) : null
  const permissions = mode
    ? modeToPermissionSet(mode, defaultPermissions)
    : defaultPermissions
  const materialized = registry.materialize(permissions)
  // invalid 是内部自愈修复工具，不暴露给 UI 工具面板
  let toolNames = Object.keys(materialized.definitions).filter((n) => n !== "invalid")
  if (modeConfig?.toolAllowlist && modeConfig.toolAllowlist.length > 0) {
    const allowed = new Set(modeConfig.toolAllowlist)
    toolNames = toolNames.filter((n) => allowed.has(n))
  }
  return toolNames.map((name) => {
    const def = registry.get(name)
    return {
      name,
      description: def?.description || "",
      parameters: def ? getJsonSchema(def) : { type: "object", properties: {} },
    }
  })
}

export function handleListAgents(): any[] {
  return agentRegistry.list()
}

export async function handleExecuteTool(toolName: string, args: Record<string, unknown>): Promise<any> {
  const ctx = {
    sessionID: "ipc",
    workspace: process.cwd(),
    mode: "assistant" as const,
    agent: "user",
    assistantMessageID: "direct",
    toolCallID: "direct",
  }
  // 收敛到 ctx.tools 四阶段调度器（消除直连 registry 旁路；复用同一 registry + 事件接缝）
  const mira = await getMiraContext()
  const toolsService = mira.tools
  if (toolsService?.execute) {
    return await toolsService.execute(toolName, args, ctx)
  }
  return await registry.execute(toolName, args, ctx)
}

export async function handleExecuteBatch(calls: Array<{ name: string; args: Record<string, unknown> }>): Promise<any[]> {
  const ctx = {
    sessionID: "ipc",
    workspace: process.cwd(),
    mode: "assistant" as const,
    agent: "user",
    assistantMessageID: "batch",
    toolCallID: "batch",
  }
  // 批量收敛到 ctx.tools 四阶段调度器（复用同一 registry + 事件接缝）
  const mira = await getMiraContext()
  const toolsService = mira.tools
  if (toolsService?.execute) {
    return await Promise.all(calls.map((c) => toolsService.execute(c.name, c.args, ctx)))
  }
  return await Promise.all(calls.map((c) => registry.execute(c.name, c.args, ctx)))
}

// ── Memory 搜索 ──────────────────────────────────────

interface FTSProvider {
  search(query: string): Promise<string>
  searchMemory(query: string, limit: number): Promise<string>
  searchMemoryByProject(query: string, projectId: string, limit: number): Promise<Array<{ content: string; source: string; sessionId: string }>>
}

let memoryFTS: FTSProvider | null = null

export function setMemoryFTS(p: FTSProvider): void {
  memoryFTS = p
}

export async function handleMemorySearch(query: string, type?: string, limit?: number): Promise<{ results: string[]; error: string | null }> {
  // 首次记忆搜索时按需初始化共享 FTS（启动不预加载，避免阻塞 Sidecar）
  await ensureSharedMemoryFTS()
  const fts = memoryFTS
  if (!fts) return { results: [], error: "FTS not initialized" }

  const results: string[] = []
  const maxLimit = Math.min(limit || 5, 20)

  try {
    if (!type || type === "files" || type === "all") {
      const r = await fts.search(query)
      if (r) results.push(r)
    }
    if (!type || type === "memory" || type === "all") {
      const r = await fts.searchMemory(query, maxLimit)
      if (r) results.push(r)
    }
    return { results, error: null }
  } catch (err: any) {
    return { results: [], error: err.message }
  }
}

export function handleMemoryStatus(): { available: boolean; provider: string } {
  return {
    available: !!memoryFTS,
    provider: memoryFTS ? "fts5" : "none",
  }
}

export async function handleMemorySearchByProject(
  query: string,
  projectId: string,
  limit?: number,
): Promise<Array<{ content: string; source: string; sessionId: string }>> {
  // 首次按项目查询时按需初始化共享 FTS（知识图谱重启后无需先发消息即可读取跨会话记忆）
  await ensureSharedMemoryFTS()
  const fts = memoryFTS
  if (!fts || !projectId) return []

  try {
    return await fts.searchMemoryByProject(query || "", projectId, limit || 100)
  } catch {
    return []
  }
}

export async function handleGetGraphData(): Promise<{ entities: Array<{ id: string; name: string; type: string; description?: string }>; relationships: Array<{ source: string; target: string; relation: string }> }> {
  // 从动态记忆图谱（SQLite 持久化）读取真实节点/边，供 UI 3D 图谱渲染
  try {
    const graph = await loadGraph()
    const entities = Array.from(graph.nodes.values()).map((node) => ({
      id: node.id,
      name: node.content.slice(0, 40),
      type: node.type,
      description: node.content,
    }))
    const relationships = graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
    }))
    return { entities, relationships }
  } catch (err) {
    logError("[API] handleGetGraphData 读取图谱失败", err)
    return { entities: [], relationships: [] }
  }
}

/** 用 LLM 为会话生成追问建议 */
export async function handleFollowUps(sessionId: string): Promise<{ suggestions: string[] }> {
  try {
    const session = await loadSession(sessionId)
    if (!session || session.messages.length === 0) return { suggestions: [] }

    const cfg = resolveRuntimeConfig({ workspace: session.workspace })
    const conversation: LLMMessage[] = session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }))

    const suggestions = await generateFollowUpSuggestions(conversation, {
      apiKey: cfg.apiKey,
      apiUrl: cfg.apiUrl,
      model: cfg.model,
      provider: cfg.provider || "openai",
    })
    return { suggestions }
  } catch (err) {
    logError("[API] handleFollowUps 失败", err)
    return { suggestions: [] }
  }
}

// ── 会话/项目数据库操作（Sidecar 单写者） ──────────────
// 主进程不再直接持有 sql.js 数据库；所有会话/项目读写经本进程执行，
// 避免双进程各自内存库互相覆盖导致消息丢失。

export function handleListProjects(): Promise<Awaited<ReturnType<typeof listProjects>>> {
  return listProjects()
}

export function handleCreateProject(name: string, workspace: string): Promise<Awaited<ReturnType<typeof createProject>>> {
  return createProject(name, workspace)
}

export function handleUpdateProject(projectId: string, data: { name?: string; workspace_path?: string }): Promise<void> {
  return updateProject(projectId, data)
}

export function handleDeleteProject(projectId: string): Promise<void> {
  return deleteProjectById(projectId)
}

export function handleCreateSession(projectId: string, title?: string): Promise<Awaited<ReturnType<typeof createSession>>> {
  return createSession(projectId, title)
}

export function handleListSessions(projectId?: string): Promise<Awaited<ReturnType<typeof listSessions>>> {
  return listSessions(projectId)
}

export function handleGetSessionMessages(sessionId: string): Promise<Awaited<ReturnType<typeof getSessionMessages>>> {
  return getSessionMessages(sessionId)
}

export function handleDeleteSession(sessionId: string): Promise<void> {
  return deleteSessionById(sessionId)
}

export function handleDeleteSessions(sessionIds: string[]): Promise<void> {
  return deleteSessionsById(sessionIds)
}

export function handleDeleteMessage(sessionId: string, messageId: number): Promise<void> {
  return deleteMessageById(sessionId, messageId)
}

export function handleSearchMessages(query: string): Promise<Awaited<ReturnType<typeof searchMessages>>> {
  return searchMessages(query)
}

export function handleUpdateSession(sessionId: string, data: { title?: string }): Promise<void> {
  return updateSession(sessionId, data)
}

export function handleRestoreSnapshot(snapshotId: string, workspace: string): Promise<Awaited<ReturnType<typeof restoreSnapshot>>> {
  return restoreSnapshot(snapshotId, workspace)
}

// ── 子 Agent（Sidecar 单写者） ─────────────────────────
// 共享实例：sidecar 的 spawn_agent/delegate_task 工具与 HTTP 端点共用，
// 避免主进程再创建 SubagentManager 写 actor_registry。

const subagentManager = new SubagentManager(registry, { maxParallel: 5 })
setSubagentManager(subagentManager)

export function handleSubagentSpawn(description: string, config: Record<string, unknown>, options?: { parentId?: string; prompt?: string; model?: string }) {
  return subagentManager.spawn(description, config as unknown as AgentConfig, options)
}

export async function handleSubagentWait(id: string, timeoutMs?: number) {
  return await subagentManager.wait(id, timeoutMs)
}

export function handleSubagentCancel(id: string): boolean {
  return subagentManager.cancel(id)
}

export function handleSubagentGet(id: string) {
  return subagentManager.getInfo(id)
}

export function handleSubagentList(filter?: { parentId?: string; status?: SubagentStatus }) {
  return subagentManager.list(filter)
}

export function handleSubagentListActive() {
  return subagentManager.listActive()
}

export function handleSubagentListByParent(parentId: string) {
  return subagentManager.listByParent(parentId)
}

export function handleSubagentCancelByParent(parentId: string): boolean {
  subagentManager.cancelAllByParent(parentId)
  return true
}

export function handleSubagentCancelAll(): boolean {
  subagentManager.cancelAll()
  return true
}

export function handleSubagentToText(): string {
  return subagentManager.toText()
}

// ── Goal（Sidecar 单写者） ─────────────────────────────

const goalJudge = new GoalJudge()

export function handleGoalSet(description: string, timeoutMs?: number) {
  return goalJudge.setGoal(description, timeoutMs)
}

export function handleGoalGetActive() {
  return goalJudge.getActiveGoal()
}

export function handleGoalList() {
  return goalJudge.getAllGoals()
}

export function handleGoalCancel(): boolean {
  return goalJudge.cancelGoal()
}

export function handleGoalToText(): string {
  return goalJudge.toText()
}

export async function handleGoalLoad(sessionID: string) {
  await goalJudge.load(sessionID)
  return goalJudge.getAllGoals()
}

export async function handleGoalSave(): Promise<void> {
  return goalJudge.save()
}

// ── Task（Sidecar 单写者，taskTracker 已在 stream 初始化） ──

export function handleTaskCreate(summary: string, parentId?: string) {
  return taskTracker.create(summary, parentId)
}

export function handleTaskUpdateStatus(taskId: string, status: string): boolean {
  return taskTracker.updateStatus(taskId, status as TaskStatus)
}

export function handleTaskUpdateSummary(taskId: string, summary: string): boolean {
  return taskTracker.updateSummary(taskId, summary)
}

export function handleTaskAddNote(taskId: string, note: string): boolean {
  return taskTracker.addNote(taskId, note)
}

export function handleTaskGet(taskId: string) {
  return taskTracker.getTask(taskId)
}

export function handleTaskList(status?: string) {
  if (status) return taskTracker.getAllTasks().filter((t) => t.status === status)
  return taskTracker.getAllTasks()
}

export function handleTaskListActive() {
  return taskTracker.getActiveTasks()
}

export function handleTaskToText(): string {
  return taskTracker.toText()
}

// ── Question（Sidecar 单写者，命中 sidecar 进程内 pendingQuestions） ──

export function handleQuestionAnswer(questionId: string, answer: string): boolean {
  return answerQuestion(questionId, answer)
}

export function handleQuestionListPending() {
  return getPendingQuestions()
}

// ── Graph 图编排（Sidecar 单写者） ─────────────────────

const activeGraphRuns = new Map<string, { promise: Promise<GraphRunResult<CodingState>> }>()

export function handleRunGraphTask(
  request: string,
  config: Record<string, unknown>,
  options: { maxSteps?: number; testCommand?: string; maxTotalTokens?: number },
  ctx: APIContext,
  runId: string,
): void {
  const graph = buildCodingTaskGraph(registry, config as unknown as AgentConfig, {
    request,
    maxSteps: options?.maxSteps,
    testCommand: options?.testCommand,
    collectEvents: true,
  })
  const engine = new StateGraph<CodingState>(graph)

  const promise = engine.run({
    runId,
    maxTotalTokens: options?.maxTotalTokens,
    initialState: {
      request,
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
    onEvent: (evt) => ctx.writeEvent({ type: "graph_event", event: evt }),
  })

  activeGraphRuns.set(runId, { promise })
  void promise
    .then((result) => {
      ctx.writeEvent({
        type: "graph_result",
        runId,
        status: result.status,
        state: result.state,
        visited: result.visited,
        totalTokens: result.totalTokens,
        error: result.error,
      })
    })
    .finally(() => {
      ctx.writeEnd()
      activeGraphRuns.delete(runId)
    })
    .catch(() => {
      try { ctx.writeEnd() } catch { /* ignore */ }
      activeGraphRuns.delete(runId)
    })
}

export function handleGraphGetStatus(runId: string) {
  return activeGraphRuns.has(runId) ? { runId, active: true } : { runId, active: false }
}

export function handleGraphListRuns(graphId?: string) {
  return new GraphPersist().listCheckpoints(graphId || "coding-task")
}

export function handleGraphStop(runId: string): boolean {
  if (!activeGraphRuns.has(runId)) return false
  activeGraphRuns.delete(runId)
  return true
}
