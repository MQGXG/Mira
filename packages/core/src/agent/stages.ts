/**
 * Agent 循环阶段 — 从 agent.ts 拆分的 5 阶段 + 辅助函数
 *
 * 拆分目标：循环阶段的物理解耦（单一职责，agent.ts 只留编排）。
 * 阶段函数经 AgentInternals 接口读取内部状态（asInternals 断言，零运行时开销）。
 * 行为与原 agent.ts 私有方法完全一致。
 */

import { join } from "path"
import { createHash } from "crypto"
import { promises as fs } from "fs"
import { getPlatformPaths } from "../config/paths"
import type { LLMMessage } from "../llm/client"
import { repairMessageSequence } from "../shared/message-utils"
import { appendMessage, loadSession } from "../session/store"
import { MemoryExtractor, createExtractorLlmCall } from "../memory/memory-extractor"
import { applyRecallBudget } from "../memory/recall-budget"
import { calculateStrength } from "../memory/memory-strength"
import { getSessionMessages } from "../session/manager"
import { buildToolContext, buildSystemMessage, createSourceManager, prepareSourceManagerContext } from "./context"
import type { LLMTurnConfig } from "./turn"
import { getModeMaxIterations, getModeSystemPromptSuffix } from "../config/modes"
import { DEFAULT_SYSTEM, type AgentConfig } from "./constants"
import { modelHasVision } from "../llm/transform"
import { ProviderCatalog } from "../llm/provider-catalog"
import type { TurnRunnerOutput } from "./turn-runner"
import { asInternals, type AgentInternals } from "./agent-internals"
import type { FileRef } from "./agent"
import type { AgentEvent } from "../types"

/* ── 文件级解析函数（原 agent.ts 底部） ── */

/** 解析 user 消息 JSON {text, images:[paths]}，非此格式返回 null */
function tryParseUserWithImages(content: string): { text: string; images: string[]; files: FileRef[] } | null {
  if (!content.trim().startsWith("{")) return null
  try {
    const parsed = JSON.parse(content) as { text?: unknown; images?: unknown; files?: unknown }
    if (parsed && typeof parsed === "object") {
      const images = Array.isArray(parsed.images)
        ? parsed.images.filter((p: unknown): p is string => typeof p === "string")
        : []
      const files = Array.isArray(parsed.files)
        ? parsed.files.filter((f): f is FileRef => !!f && typeof f === "object" && typeof (f as FileRef).name === "string")
        : []
      if (images.length > 0 || files.length > 0) {
        return { text: typeof parsed.text === "string" ? parsed.text : "", images, files }
      }
    }
  } catch { /* json parse fallback */ }
  return null
}

function hasToolCalls(content: string | any[]): boolean {
  if (Array.isArray(content)) return content.some((p) => p.type === "tool-call")
  return false
}

function tryParseAssistantPayload(content: string): { text: string; tool_calls: Array<{ id: string; name: string; args: string }>; reasoning_content?: string } | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.tool_calls)) {
      return { text: parsed.text || "", tool_calls: parsed.tool_calls, reasoning_content: parsed.reasoning_content }
    }
    if (parsed && typeof parsed === "object" && "text" in parsed && "reasoning_content" in parsed) {
      return { text: parsed.text || "", tool_calls: [], reasoning_content: parsed.reasoning_content }
    }
  } catch { /* json parse fallback */ }
  return null
}

/* ── 辅助函数 ── */

/** 读取附件文件为 data URL（{userData}/{relPath}），失败返回 null */
async function readAttachmentDataUrl(relPath: string): Promise<string | null> {
  try {
    const abs = join(getPlatformPaths().userData, relPath)
    const data = await fs.readFile(abs)
    const ext = relPath.split(".").pop()?.toLowerCase() || "png"
    const mime = ext === "pdf" ? "application/pdf"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "gif" ? "image/gif"
      : ext === "webp" ? "image/webp"
      : "image/png"
    return `data:${mime};base64,${data.toString("base64")}`
  } catch { return null }
}

/** 持久化用户上传的图片到 {userData}/attachments/{sessionId}/，返回相对路径数组 */
async function persistImages(sessionId: string, images: string[]): Promise<string[]> {
  const paths: string[] = []
  try {
    const baseDir = join(getPlatformPaths().userData, "attachments", sessionId)
    await fs.mkdir(baseDir, { recursive: true })
    for (let i = 0; i < images.length; i++) {
      const dataUrl = images[i]
      const mimeMatch = /^data:((?:image|application)\/[a-z0-9.+-]+);base64,(.*)$/s.exec(dataUrl)
      if (!mimeMatch) continue
      const mime = mimeMatch[1]
      const base64 = mimeMatch[2]
      const ext = mime === "application/pdf" ? "pdf" : (mime.split("/")[1]?.replace("+", "-") || "png")
      const fileName = `${Date.now()}_${i}.${ext}`
      const filePath = join(baseDir, fileName)
      await fs.writeFile(filePath, Buffer.from(base64, "base64"))
      paths.push(`attachments/${sessionId}/${fileName}`)
    }
  } catch { /* 落盘失败不阻断主流程 */ }
  return paths
}

/** 低频自动图谱维护（D 优化）：距上次维护超过阈值才执行衰减/固化 */
async function maybeMaintainGraph(a: AgentInternals): Promise<void> {
  const now = Date.now()
  const THRESHOLD_MS = 60 * 60 * 1000 // 1 小时
  if (now - a.lastGraphMaintenanceAt < THRESHOLD_MS) return
  a.lastGraphMaintenanceAt = now
  try {
    const forgotten = await a.dynamicMemory.performDecay()
    const consolidated = await a.dynamicMemory.performConsolidation()
    if (forgotten > 0 || consolidated > 0) {
      a.miraCtx?.emit("graph/maintenance", { forgotten, consolidated })
    }
  } catch {
    // 维护失败静默，不影响会话收尾
  }
}

/** 会话结束自动记忆提取（M9）：用轻量文本模型从本次转写提取用户长期事实 */
async function maybeExtractSessionMemory(a: AgentInternals, config: AgentConfig): Promise<void> {
  if (!config.sessionID || !config.apiKey) return
  const fts = a.memoryManager.getFTSProvider()
  if (!fts) return
  try {
    const llmCall = await createExtractorLlmCall({
      provider: config.provider || "openai",
      model: config.model,
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      headers: config.headers,
      options: config.options,
    })
    if (!llmCall) return
    const extractor = new MemoryExtractor({
      store: {
        list: (sessionID, limit) => fts.listMemories(sessionID, limit),
        remember: (content, sessionID) => {
          // 写入全文搜索记忆（原有链路）
          fts.remember(content, sessionID)
          // 同步沉淀进动态记忆图谱（失败静默，不阻断会话收尾）
          rememberExtractedToGraph(a, content).catch(() => {})
        },
      },
      listMessages: (sessionID) => getSessionMessages(sessionID),
      llmCall,
      minUserMessages: 4,
      keepInferred: config.keepInferredMemories,
    })
    await extractor.maybeRun(config.sessionID)
  } catch {
    // 提取失败绝不阻断会话收尾
  }
}

/** 将提取的记忆沉淀进动态记忆图谱（M9 扩展），id 用内容哈希保证稳定去重 */
async function rememberExtractedToGraph(a: AgentInternals, content: string): Promise<void> {
  const raw = String(content || "").trim()
  if (!raw) return
  const match = /^\[(persona|episodic|instruction)\]\s*(.*)$/.exec(raw)
  const prefix = match?.[1]
  const clean = (match?.[2] || raw).trim()
  if (!clean) return
  const graphType = prefix === "persona" ? "declarative"
    : prefix === "instruction" ? "procedural"
    : "episodic"
  const id = `mem-${createHash("sha256").update(clean).digest("hex").slice(0, 16)}`
  await a.dynamicMemory.addNode(id, clean, graphType)
  for (const prevId of a.graphBatchIds) {
    if (prevId !== id) {
      try {
        await a.dynamicMemory.addEdge(prevId, id, "co_occurred", 0.5)
      } catch { /* 建边失败静默 */ }
    }
  }
  a.graphBatchIds.push(id)
  if (a.graphBatchIds.length > 32) a.graphBatchIds.shift()
}

/** 动态记忆图谱激活召回：在每次 LLM 调用前注入相关记忆 */
async function injectGraphMemory(a: AgentInternals, messages: LLMMessage[]): Promise<LLMMessage[]> {
  let query = ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user" && typeof msg.content === "string") {
      query = msg.content.slice(0, 200)
      break
    }
  }
  if (!query) return messages

  try {
    const result = await a.dynamicMemory.activate(query)
    if (result.nodes.length === 0) return messages

    const lines = result.nodes.slice(0, 15).map((node) => {
      const strength = calculateStrength(node).toFixed(2)
      return `- [${node.type}] ${node.content} (强度 ${strength})`
    })
    const budgeted = applyRecallBudget(lines, { maxCharsPerMemory: 300, maxTotalRecallChars: 3000 })
    if (budgeted.length === 0) return messages

    const memoryPrompt = `## 动态记忆图谱相关记忆\n${budgeted.join("\n")}\n\n（以上为与当前问题相关的长期记忆，可参考其中稳定的用户偏好/决策/规则）`
    return [{ role: "system", content: memoryPrompt }, ...messages]
  } catch {
    return messages
  }
}

/* ── 阶段 1: prepareRun ── */

export interface PrepareRunResult {
  ctx: ReturnType<typeof buildToolContext>
  toolSet: Record<string, any>
  llmConfig: LLMTurnConfig
  maxSteps: number
}

export async function prepareRun(agent: unknown, config: AgentConfig): Promise<PrepareRunResult> {
  const a = asInternals(agent)
  if (!ProviderCatalog.isInitialized()) ProviderCatalog.initProviderCatalog()

  // 每次 run 重置图谱共现批次（会话收尾提取的记忆仅与本会话批次互连）
  a.graphBatchIds = []

  const ctx = buildToolContext(config)
  if (config.permissions) a.approvalStore.setPermissions(config.permissions)

  const modelFilter = { providerID: config.provider || "openai", modelID: config.model }

  // Cordis 作用域物化激活：有 ctx.tools 时用 ScopedToolRegistry
  let toolSet: Record<string, any>
  if (a.miraCtx?.tools) {
    toolSet = a.miraCtx.tools.materializeScoped({
      mode: config.mode,
      modelFilter,
      permissions: config.permissions,
      toolAllowlist: config.toolAllowlist,
    })
  } else {
    const materialized = a.registry.materializeWithModel(modelFilter, config.permissions)
    toolSet = materialized.definitions
  }
  // invalid 是内部自愈修复工具，不暴露给 LLM
  if (toolSet && "invalid" in toolSet) {
    const { invalid: _invalid, ...rest } = toolSet
    toolSet = rest
  }
  if (config.toolAllowlist && config.toolAllowlist.length > 0) {
    const allowed = new Set(config.toolAllowlist)
    toolSet = Object.fromEntries(Object.entries(toolSet).filter(([name]) => allowed.has(name)))
  }

  await a.contextManager.initialize(config.sessionID, config.workspace)
  a.goalJudge.bindSession(config.sessionID)

  if (config.workspace) {
    const { sourceManager, sources } = createSourceManager(config.workspace)
    a.sourceManager = sourceManager
    a.sourceManagerSources = sources
  }

  a.miraCtx?.emit("session/start", { sessionID: config.sessionID, workspace: config.workspace })

  if (config.goalDescription) {
    a.goalJudge.setGoal(config.goalDescription)
    if (config.judgeModel && config.apiKey) {
      a.goalJudge.setJudgeConfig({
        apiKey: config.apiKey, apiUrl: config.apiUrl, model: config.judgeModel,
        provider: config.judgeProvider || config.provider || "openai",
      })
    } else if (config.apiKey) {
      a.goalJudge.setJudgeConfig({
        apiKey: config.apiKey, apiUrl: config.apiUrl, model: config.model,
        provider: config.provider || "openai",
      })
    }
  }

  const modeMaxSteps = getModeMaxIterations(config.mode || "assistant")
  const maxSteps = config.maxSteps || modeMaxSteps || 10
  const llmConfig: LLMTurnConfig = {
    provider: config.provider || "openai", model: config.model,
    apiKey: config.apiKey, apiUrl: config.apiUrl,
    headers: config.headers, options: config.options,
  }

  return { ctx, toolSet, llmConfig, maxSteps }
}

/* ── 阶段 2: restoreSession ── */

export async function restoreSession(agent: unknown, history: LLMMessage[], config: AgentConfig): Promise<LLMMessage[]> {
  const a = asInternals(agent)
  if (history.length > 0) return history
  const stored = await loadSession(config.sessionID)
  if (!stored || stored.messages.length === 0) return history

  const restored: LLMMessage[] = []
  for (const m of stored.messages) {
    if (m.role === "assistant") {
      const parsed = tryParseAssistantPayload(m.content)
      if (parsed) {
        restored.push({
          role: "assistant",
          content: [
            { type: "text", text: parsed.text },
            ...parsed.tool_calls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.id, toolName: tc.name,
              args: JSON.parse(tc.args),
            })),
          ],
          ...(parsed.reasoning_content ? { reasoning_content: parsed.reasoning_content } : {}),
        })
        continue
      }
      restored.push({ role: "assistant", content: m.content })
      continue
    }
    if (m.role === "tool") {
      if (!m.toolCallId) {
        restored.push({ role: "tool", content: [{ type: "tool-result" as const, toolCallId: "unknown", toolName: "unknown", output: m.content }] })
        continue
      }
      const lastAssistant = [...restored].reverse().find(r => r.role === "assistant")
      if (lastAssistant && typeof lastAssistant.content === "string" && !hasToolCalls(lastAssistant.content)) {
        lastAssistant.content += `\n\n[Tool result: ${m.content.slice(0, 500)}]`
        continue
      }
      restored.push({ role: "tool", content: [{ type: "tool-result" as const, toolCallId: m.toolCallId, toolName: "unknown", output: m.content }], tool_call_id: m.toolCallId })
      continue
    }
    // user 消息：若为 JSON {text, images, files} 则恢复文本并读回图片/文件提示
    const parsedUser = tryParseUserWithImages(m.content)
    if (parsedUser) {
      const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }> =
        [{ type: "text" as const, text: parsedUser.text }]
      const modelCanSeeImages = modelHasVision(config.provider || "", config.model, config.modelVision)
      if (modelCanSeeImages) {
        for (const relPath of parsedUser.images) {
          const dataUrl = await readAttachmentDataUrl(relPath)
          if (dataUrl) {
            const mime = /^data:(image\/[a-z0-9.+-]+);/.exec(dataUrl)?.[1] || "image/png"
            contentParts.push({ type: "image" as const, image: dataUrl, mediaType: mime })
          }
        }
      } else if (parsedUser.images.length > 0) {
        contentParts.push({ type: "text" as const, text: `[用户在此条消息附了 ${parsedUser.images.length} 张图片，如需回顾请用 read_file 查看附件：${parsedUser.images.join(", ")}]` })
      }
      for (const f of parsedUser.files) {
        if (f.kind === "text" && f.path) {
          contentParts.push({ type: "text" as const, text: `📎 ${f.name} (${f.path})` })
        } else if (f.name) {
          contentParts.push({ type: "text" as const, text: `📎 ${f.name}` })
        }
      }
      restored.push({ role: "user", content: contentParts })
      continue
    }
    restored.push({ role: "user", content: m.content })
  }

  // 修复消息序列（孤立 tool / 乱序 tool），确保发给 LLM 的序列合法
  const repaired = repairMessageSequence(restored)
  const rebuilt = a.contextManager.onSessionResume(repaired, config.sessionID)
  return rebuilt.length > repaired.length ? rebuilt : repaired
}

/** 阶段 2.5: 图片落盘（供 _runCore 调用） */
export async function persistUploadedImages(sessionId: string, images: string[]): Promise<string[]> {
  return persistImages(sessionId, images)
}

/* ── 阶段 3: buildMessages ── */

export async function buildMessages(
  agent: unknown,
  config: AgentConfig,
  userMessage: string,
  enrichedUser: string,
  memoryPrompt: string,
  history: LLMMessage[],
  imagePaths?: string[],
  fileRefs?: FileRef[],
): Promise<LLMMessage[]> {
  const a = asInternals(agent)
  // 含图片/文件时以 JSON 落库
  const hasMedia = (imagePaths && imagePaths.length > 0) || (fileRefs && fileRefs.length > 0)
  const storedContent = hasMedia
    ? JSON.stringify({
        text: userMessage,
        ...(imagePaths && imagePaths.length > 0 ? { images: imagePaths } : {}),
        ...(fileRefs && fileRefs.length > 0 ? { files: fileRefs } : {}),
      })
    : userMessage
  await appendMessage(config.sessionID, {
    role: "user", content: storedContent, timestamp: new Date().toISOString(),
  })
  a.miraCtx?.emit("session/prompt-submit", { sessionID: config.sessionID, message: userMessage })

  const goalPrompt = a.goalJudge.toSystemPrompt()
  let systemContent: string
  if (a.sourceManager && a.sourceManagerSources) {
    await prepareSourceManagerContext(a.sourceManager, a.sourceManagerSources, config, memoryPrompt, goalPrompt)
    const separated = await a.sourceManager.buildSeparated({
      sessionID: config.sessionID, workspace: config.workspace, mode: config.mode,
      customSystemPrompt: config.systemPrompt || DEFAULT_SYSTEM, currentFile: config.currentFile,
    })
    systemContent = separated.context
      ? `${separated.system}\n\n${separated.context}`
      : separated.system
  } else {
    const modeSuffix = getModeSystemPromptSuffix(config.mode || "assistant")
    const baseSystem = await buildSystemMessage(config, memoryPrompt, DEFAULT_SYSTEM)
    const systemWithMode = modeSuffix ? `${baseSystem}\n\n[MODE: ${config.mode}]\n${modeSuffix}` : baseSystem
    systemContent = goalPrompt ? `${systemWithMode}\n\n${goalPrompt}` : systemWithMode
  }

  // 模型身份注入
  const modelLine = config.model
    ? `Running model: ${config.model}${config.provider ? ` (provider: ${config.provider})` : ""}`
    : ""
  systemContent = modelLine ? `${systemContent}\n\n<model>\n  ${modelLine}\n</model>` : systemContent

  return [
    { role: "system", content: systemContent },
    ...history.map((m) => {
      const role = String(m.role || "user") as LLMMessage["role"]
      const content = m.content
      if (role === "assistant" && "tool_calls" in m && m.tool_calls && typeof content === "string") {
        const oldTc = m.tool_calls as Array<{ id?: string; name?: string; args?: unknown; toolCallId?: string; toolName?: string; function?: { name?: string; arguments?: string } }>
        const assistantMsg: LLMMessage = {
          role: "assistant",
          content: [
            { type: "text" as const, text: content },
            ...oldTc.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: String(tc.id || tc.toolCallId || ""),
              toolName: String(tc.function?.name || tc.toolName || ""),
              args: typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.args || {}),
            })),
          ],
        }
        return assistantMsg
      }
      const msg: LLMMessage = { role, content }
      if (m.tool_call_id) msg.tool_call_id = String(m.tool_call_id)
      return msg
    }),
    { role: "user", content: enrichedUser },
  ]
}

/* ── 阶段 4: handleTurnOutput ── */

export async function* handleTurn(
  agent: unknown,
  turnOutput: TurnRunnerOutput,
  messages: LLMMessage[],
  config: AgentConfig,
  currentInput: { message: string },
  allToolCalls: Array<{ name: string; args: string }>,
): AsyncGenerator<AgentEvent, { messages: LLMMessage[]; shouldContinue: boolean }> {
  const a = asInternals(agent)
  messages = turnOutput.messages

  if (turnOutput.signal === "context_overflow") {
    yield { type: "thinking", text: "⚠️ Context too long, performing emergency compaction..." }
    const compacted = await a.contextManager.reactiveCompact(messages, config.sessionID)
    if (compacted.length < messages.length) {
      messages.length = 0
      messages.push(...compacted)
      yield { type: "thinking", text: "🔄 Emergency compaction complete, retrying..." }
      return { messages, shouldContinue: true }
    }
    yield { type: "error", message: "Context overflow: compaction failed to reduce size" }
    return { messages, shouldContinue: false }
  }

  if (turnOutput.signal === "stop") {
    const llmFailedWithError = !!turnOutput.error
    if (!a.stateMachine.aborted && (llmFailedWithError || (!turnOutput.text && turnOutput.toolCalls.length === 0))) {
      if (turnOutput.text) {
        try {
          await appendMessage(config.sessionID, { role: "assistant", content: turnOutput.text, timestamp: new Date().toISOString(), retryCount: turnOutput.retryCount || 0 })
        } catch { /* 持久化失败不阻塞 */ }
      }
      const msg = `⚠️ 模型调用失败${turnOutput.error ? `：${turnOutput.error}` : ""}，请检查 API Key / 模型配置后重试。`
      try {
        await appendMessage(config.sessionID, { role: "assistant", content: msg, timestamp: new Date().toISOString() })
      } catch { /* 持久化失败不阻塞 */ }
    }
    yield { type: "finish", reason: a.stateMachine.aborted ? "stopped" : "error", usage: turnOutput.usage }
    return { messages, shouldContinue: false }
  }

  if (!turnOutput.text && turnOutput.toolCalls.length === 0) {
    if (a.stateMachine.aborted) yield { type: "finish", reason: "stopped", usage: turnOutput.usage }
    return { messages, shouldContinue: false }
  }

  if (turnOutput.toolCalls.length > 0) {
    const allNames = turnOutput.toolCalls.map(tc => tc.name)
    const isSearchTurn = allNames.some(n => ["web_search", "web_fetch", "web_browse", "web_fetch_url"].includes(n))
    const MAX_PURE_TOOL_TURNS = isSearchTurn ? 4 : 8
    if (!turnOutput.text) {
      a.consecutiveToolTurns++
    } else {
      a.consecutiveToolTurns = 0
    }
    if (a.consecutiveToolTurns >= MAX_PURE_TOOL_TURNS) {
      yield { type: "thinking", text: `⛔ 已连续 ${a.consecutiveToolTurns} 轮工具调用但未产生回复，强制总结当前结果并停止。` }
      messages.push({ role: "user", content: "你已经连续调用工具多次但尚未给出文字回复。请立即基于已有信息总结回答，不要再调用任何工具。" })
      a.consecutiveToolTurns = 0
      return { messages, shouldContinue: true }
    }

    for (const tc of turnOutput.toolCalls) allToolCalls.push({ name: tc.name, args: tc.arguments })
    const lastCall = turnOutput.toolCalls[turnOutput.toolCalls.length - 1]
    const { detectDoomLoop } = await import("./utils")
    if (detectDoomLoop({ name: lastCall.name, args: lastCall.arguments }, allToolCalls.slice(0, -1))) {
      const { id, waitForReply } = a.stateMachine.createPermissionRequest()
      yield { type: "permission_request", id, action: "doom_loop", resources: [`${lastCall.name}(${lastCall.arguments.slice(0, 100)})`], toolCall: { id: lastCall.id, name: lastCall.name, input: {} } }
      const allowed = await waitForReply()
      if (!allowed) {
        yield { type: "thinking", text: "⛔ Doom loop blocked by user" }
        yield { type: "finish", reason: "doom_loop_blocked" }
        return { messages, shouldContinue: false }
      }
    }
  }

  if (turnOutput.toolCalls.length === 0) {
    const content = turnOutput.reasoningContent
      ? JSON.stringify({ text: turnOutput.text || "", reasoning_content: turnOutput.reasoningContent })
      : (turnOutput.text || "")
    await appendMessage(config.sessionID, { role: "assistant", content, timestamp: new Date().toISOString(), retryCount: turnOutput.retryCount || 0 })
    if (turnOutput.reasoningContent) {
      messages.push({
        role: "assistant",
        content: turnOutput.text || "",
        reasoning_content: turnOutput.reasoningContent,
      })
    } else if (turnOutput.text) {
      messages.push({ role: "assistant", content: turnOutput.text })
    }

    const activeGoal = a.goalJudge.getActiveGoal()
    if (activeGoal) {
      const quickCheck = a.goalJudge.quickCheck(activeGoal, messages)
      if (quickCheck?.satisfied) {
        activeGoal.status = "satisfied"
        yield { type: "goal_status", goalId: activeGoal.id, description: activeGoal.description, status: "satisfied", reasoning: quickCheck.reasoning }
        yield { type: "finish", reason: "goal_satisfied" }
        return { messages, shouldContinue: false }
      }
      const evaluation = await a.goalJudge.evaluate(activeGoal, messages)
      yield { type: "goal_status", goalId: activeGoal.id, description: activeGoal.description, status: evaluation.satisfied ? "satisfied" : "still_active", reasoning: evaluation.reasoning }
      if (evaluation.satisfied) {
        yield { type: "finish", reason: "goal_satisfied" }
        return { messages, shouldContinue: false }
      }
      yield { type: "thinking", text: `🎯 Goal still active: ${evaluation.reasoning}` }
      return { messages, shouldContinue: true }
    }

    // agent/turn-stopping（serial，原 stop 槽位）：返回非空即强制继续
    const stopMessage = a.miraCtx
      ? await a.miraCtx.serial("agent/turn-stopping", { messages, config })
      : null
    if (stopMessage) {
      messages.push({ role: "user", content: String(stopMessage) })
      return { messages, shouldContinue: true }
    }
    yield { type: "finish", reason: "stop", usage: turnOutput.usage }
    return { messages, shouldContinue: false }
  }

  const { messages: postToolMessages, didRebuild, reason } = await a.contextManager.checkAndRebuild(messages, config.sessionID)
  if (didRebuild) {
    messages = postToolMessages
    yield { type: "thinking", text: "🔄 Context compacted after tool execution" }
    yield { type: "context_rebuild", reason, tokensBefore: 0, tokensAfter: 0 }
  }

  return { messages, shouldContinue: true }
}

/* ── 阶段 5: finalizeRun ── */

export async function finalizeRun(agent: unknown, config: AgentConfig): Promise<void> {
  const a = asInternals(agent)
  a.miraCtx?.emit("session/end", { sessionID: config.sessionID, workspace: config.workspace })
  await maybeExtractSessionMemory(a, config)
  await maybeMaintainGraph(a)
  await a.contextManager.shutdown()
  a.memoryManager.shutdown().catch(() => {})
}

/** 动态记忆图谱激活召回（供 _runCore 的 pre_llm 钩子使用） */
export async function injectGraphMemoryStage(agent: unknown, messages: LLMMessage[]): Promise<LLMMessage[]> {
  return injectGraphMemory(asInternals(agent), messages)
}
