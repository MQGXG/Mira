import type { ToolContext } from "../shared/tool"
import type { AgentMode } from "../config/modes"
import * as fs from "fs"
import * as path from "path"
import { CodeContext } from "../lsp/code-context"
import {
  SourceManager,
  BaseSource,
  EnvSource,
  ModeSource,
  MemorySource,
  CodeSource,
  GoalSource,
  KnowledgeSource,
  type SourceContext,
} from "../session/context-source"
import { getModeSystemPromptSuffix } from "../config/modes"

const codeContext = new CodeContext()

export interface AgentRunConfig {
  sessionID: string
  workspace: string
  mode?: AgentMode
  systemPrompt?: string
  options?: Record<string, unknown>
  currentFile?: string
  /** LLM 凭据（透传给工具上下文，供委托/子 Agent 工具继承父配置） */
  apiKey?: string
  apiUrl?: string
  provider?: string
  model?: string
  headers?: Record<string, string>
}

// ── SourceManager 工厂 ───────────────────────────────────

/** 创建 SourceManager 并注册所有默认 Sources */
export function createSourceManager(workspace: string): {
  sourceManager: SourceManager
  sources: {
    base: BaseSource
    env: EnvSource
    mode: ModeSource
    memory: MemorySource
    code: CodeSource
    goal: GoalSource
    knowledge: KnowledgeSource
  }
} {
  const sm = new SourceManager(workspace)
  const base = new BaseSource()
  const env = new EnvSource()
  const mode = new ModeSource()
  const memory = new MemorySource()
  const code = new CodeSource()
  const goal = new GoalSource()
  const knowledge = new KnowledgeSource()

  sm.registerAll([base, env, mode, memory, code, goal, knowledge])

  return { sourceManager: sm, sources: { base, env, mode, memory, code, goal, knowledge } }
}

// ── 向后兼容 API ─────────────────────────────────────────

let _cachedCodeSuffix = ""
let _cachedWs = ""
let _cachedFile = ""

export function buildToolContext(config: AgentRunConfig): ToolContext {
  return {
    sessionID: config.sessionID,
    workspace: config.workspace,
    mode: config.mode || "assistant",
    agent: "build",
    assistantMessageID: "",
    toolCallID: "",
    shell: config.options?.shell as string | undefined,
    // LLM 凭据透传：委托/子 Agent 工具从 ctx 继承父配置，而非硬编码空 key/默认模型
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    provider: config.provider,
    model: config.model,
    headers: config.headers,
    options: config.options,
  }
}

/**
 * 向后兼容的 buildSystemMessage — 委托给 SourceManager
 * 新代码应使用 SourceManager.build() 直接调用
 */
export async function buildSystemMessage(
  config: AgentRunConfig,
  memoryPrompt?: string,
  defaultSystem?: string,
  sourceManager?: SourceManager,
): Promise<string> {
  // 新路径：使用 SourceManager
  if (sourceManager) {
    const ctx: SourceContext = {
      sessionID: config.sessionID,
      workspace: config.workspace,
      mode: config.mode,
      customSystemPrompt: config.systemPrompt || defaultSystem,
      currentFile: config.currentFile,
    }
    return sourceManager.build(ctx)
  }

  // 旧路径：保持原有逻辑（向后兼容）
  const base = config.systemPrompt || defaultSystem || "You are a helpful AI assistant."
  const parts = [base]

  const envParts: string[] = [
    "<env>",
    `  Working directory: ${config.workspace || "unknown"}`,
    `  Platform: ${process.platform}`,
    "</env>",
  ]
  parts.push(envParts.join("\n"))

  if (memoryPrompt) parts.push(memoryPrompt)

  if (config.workspace !== _cachedWs || config.currentFile !== _cachedFile) {
    _cachedCodeSuffix = await getCodeContextSuffix(config.workspace, config.currentFile)
    _cachedWs = config.workspace
    _cachedFile = config.currentFile || ""
  }
  if (_cachedCodeSuffix) parts.push(_cachedCodeSuffix)

  return parts.join("\n\n")
}

async function getCodeContextSuffix(workspace: string, currentFile?: string): Promise<string> {
  try {
    return await codeContext.buildSystemPromptSuffix(workspace, currentFile)
  } catch {
    return ""
  }
}

/**
 * 为 Agent.run() 构建 SourceManager 上下文
 * 设置所有动态 Source 的内容（memory、code、goal、mode、knowledge）
 */
export async function prepareSourceManagerContext(
  sourceManager: SourceManager,
  sources: {
    memory: MemorySource
    code: CodeSource
    goal: GoalSource
    mode: ModeSource
    knowledge: KnowledgeSource
  },
  config: AgentRunConfig,
  memoryPrompt?: string,
  goalPrompt?: string,
): Promise<void> {
  // 设置 memory 内容
  if (memoryPrompt) {
    sources.memory.setMemoryContent(memoryPrompt)
  }

  // 设置 code 内容
  if (config.workspace !== _cachedWs || config.currentFile !== _cachedFile) {
    const suffix = await getCodeContextSuffix(config.workspace, config.currentFile)
    sources.code.setCodeSuffix(suffix)
    _cachedWs = config.workspace
    _cachedFile = config.currentFile || ""
  }

  // 设置 goal 内容
  if (goalPrompt) {
    sources.goal.setGoalContent(goalPrompt)
  }

  // 设置 mode 内容
  if (config.mode) {
    const modeSuffix = getModeSystemPromptSuffix(config.mode)
    if (modeSuffix) {
      sources.mode.setModeSuffix?.(modeSuffix)
    }
  }

  // 注入 Dream 知识
  if (config.workspace) {
    try {
      const knowledgePath = path.join(config.workspace, ".mira", "knowledge", "knowledge.json")
      if (fs.existsSync(knowledgePath)) {
        const knowledge = JSON.parse(fs.readFileSync(knowledgePath, "utf-8")) as { entries?: Array<{ content: string }> }
        const facts = knowledge.entries?.map((e) => `- ${e.content}`).join("\n") || ""
        sources.knowledge.setKnowledgeContent(facts)
      }
    } catch { /* 静默 */ }
  }
}

