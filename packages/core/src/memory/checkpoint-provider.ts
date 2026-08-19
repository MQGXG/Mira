/**
 * Checkpoint Provider — 写作子 Agent 驱动
 * 
 * 主 Agent 的 syncTurn 只做缓冲，不阻塞。
 * checkpoint 摘要由后台 writer 异步生成。
 */

import { join } from "path"
import fs from "fs"
import type { MemoryProvider } from "./types"
import { getPlatformPaths } from "../config/paths"
import { createLLMClient, type LLMMessage } from "../llm/client"
import { logError } from "../system/logger"
import type { FTSMemoryProvider } from "./fts-memory-provider"

interface CheckpointData {
  sessionId: string
  workspace: string
  createdAt: string
  updatedAt: string
  summary: string
  activeTask: string
  recentDecisions: string[]
  keyFiles: string[]
  userPreferences: string[]
  contextBudget: number
  intent: string
  taskTree: string[]
  currentWork: string
  findings: string[]
  errorFixes: string[]
  designDecisions: string[]
}

const MAX_RECENT_DECISIONS = 20
const MAX_KEY_FILES = 30
const MAX_USER_PREFERENCES = 15
const MAX_TASK_TREE = 15
const MAX_FINDINGS = 15
const MAX_ERROR_FIXES = 10
const MAX_DESIGN_DECISIONS = 15

const WRITER_PROMPT = `Analyze the recent conversation turns and extract structured information. Focus on concrete facts, not general statements.

Output in this format:
SUMMARY: 2-4 sentence summary of what happened
INTENT: The user's overall goal
ACTIVE_TASK: Current specific task
CURRENT_WORK: What is being worked on right now
DECISIONS: Each significant decision on its own line, prefixed with -
FILES: Each file path mentioned, prefixed with -
FINDINGS: Each discovery or finding, prefixed with -
ERROR_FIXES: Each error or fix, prefixed with -
DESIGN: Each design decision, prefixed with -
TASKS: Each pending task, prefixed with -
PREFERENCES: Each user preference, prefixed with -`

export class CheckpointProvider implements MemoryProvider {
  name = "checkpoint"
  private checkpointDir = ""
  private ftsProvider: FTSMemoryProvider | null = null
  private checkpointPath = ""
  private data: CheckpointData | null = null
  private turnCount = 0
  private writerInterval = 5
  private pendingTurns: Array<{ user: string; assistant: string }> = []
  private llmConfig: { apiKey: string; apiUrl: string; model: string; provider: string } | null = null
  private writerRunning = false

  get hasLLMConfig(): boolean { return this.llmConfig !== null }

  setFTSProvider(provider: FTSMemoryProvider): void {
    this.ftsProvider = provider
  }

  async initialize(sessionId: string, workspace: string): Promise<void> {
    this.checkpointDir = join(getPlatformPaths().userData, "checkpoints", sessionId)
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true })
    }
    this.checkpointPath = join(this.checkpointDir, "checkpoint.md")
    this.loadCheckpoint(sessionId, workspace)
  }

  setLLMConfig(config: { apiKey: string; apiUrl: string; model: string; provider: string }): void {
    this.llmConfig = config
  }

  buildSystemPrompt(): string {
    if (!this.data) return ""
    const parts: string[] = []
    if (this.data.summary) parts.push(`[Session checkpoint: ${this.data.summary}]`)
    if (this.data.activeTask) parts.push(`[Active task: ${this.data.activeTask}]`)
    if (this.data.currentWork) parts.push(`[Current work: ${this.data.currentWork}]`)
    if (this.data.recentDecisions.length > 0) {
      parts.push(`[Recent decisions: ${this.data.recentDecisions.slice(-5).join("; ")}]`)
    }
    if (this.data.userPreferences.length > 0) {
      parts.push(`[User preferences: ${this.data.userPreferences.slice(-5).join("; ")}]`)
    }
    if (this.data.findings.length > 0) {
      parts.push(`[Findings: ${this.data.findings.slice(-3).join("; ")}]`)
    }
    return parts.join("\n")
  }

  async prefetch(query: string, _sessionId: string): Promise<string> {
    if (!this.data) return ""
    const parts: string[] = []
    if (this.data.summary) parts.push(`Session context: ${this.data.summary}`)
    if (this.data.activeTask) parts.push(`Active task: ${this.data.activeTask}`)
    if (this.data.currentWork) parts.push(`Current work: ${this.data.currentWork}`)
    if (this.data.keyFiles.length > 0) {
      parts.push(`Key files: ${this.data.keyFiles.slice(-8).join(", ")}`)
    }
    if (this.data.recentDecisions.length > 0) {
      parts.push(`Recent decisions: ${this.data.recentDecisions.slice(-3).join("; ")}`)
    }
    if (this.data.findings.length > 0) {
      parts.push(`Findings: ${this.data.findings.slice(-3).join("; ")}`)
    }
    if (this.data.designDecisions.length > 0) {
      parts.push(`Design decisions: ${this.data.designDecisions.slice(-3).join("; ")}`)
    }
    if (this.data.userPreferences.length > 0) {
      parts.push(`User preferences: ${this.data.userPreferences.slice(-3).join("; ")}`)
    }
    if (parts.length === 0) return ""
    return `<checkpoint-context>\n[System note: Session checkpoint context]\n\n${parts.join("\n")}\n</checkpoint-context>`
  }

  /** 只做缓冲和保存，不阻塞，不跑正则提取 */
  async syncTurn(user: string, assistant: string, sessionId: string): Promise<void> {
    this.turnCount++
    if (!this.data) {
      this.data = this.createEmptyData(sessionId)
    }
    this.data.updatedAt = new Date().toISOString()
    this.saveCheckpoint()

    this.pendingTurns.push({ user, assistant })
    if (this.pendingTurns.length > 30) {
      this.pendingTurns = this.pendingTurns.slice(-30)
    }

    // 每 writerInterval 轮触发一次后台 writer（不阻塞主循环）
    if (this.turnCount % this.writerInterval === 0 && this.llmConfig && !this.writerRunning) {
      this.runWriterAsync()
    }
  }

  async shutdown(): Promise<void> {
    this.saveCheckpoint()
  }

  getCheckpoint(): CheckpointData | null {
    return this.data
  }

  updateSummary(summary: string): void {
    if (this.data) {
      this.data.summary = summary
      this.saveCheckpoint()
    }
  }

  setActiveTask(task: string): void {
    if (this.data) {
      this.data.activeTask = task
      this.saveCheckpoint()
    }
  }

  /** 后台 Writer — 不阻塞主 Agent，fire-and-forget */
  private async runWriterAsync(): Promise<void> {
    if (this.writerRunning || !this.llmConfig || this.pendingTurns.length === 0) return
    this.writerRunning = true
    try {
      const client = createLLMClient(this.llmConfig)
      const conversationText = this.pendingTurns
        .slice(-this.writerInterval)
        .map((t) => `[user]: ${t.user.slice(0, 400)}\n[assistant]: ${t.assistant.slice(0, 600)}`)
        .join("\n\n")

      const previousSummary = this.data?.summary || "(none)"
      const messages: LLMMessage[] = [
        { role: "system", content: WRITER_PROMPT },
        { role: "user", content: `Previous summary: ${previousSummary}\n\nRecent conversation:\n${conversationText}\n\nExtract and update the checkpoint.` },
      ]

      let raw = ""
      for await (const event of client.stream({ messages })) {
        if (event.type === "delta") raw += event.delta
      }

      this.parseWriterOutput(raw)
      this.saveCheckpoint()
      if (this.ftsProvider && this.data?.summary) {
        this.ftsProvider.indexCheckpoint(this.data.summary, this.data.sessionId)
      }
    } catch (err) {
      logError("[CheckpointProvider] Writer failed", err)
    } finally {
      this.writerRunning = false
    }
  }

  /** 解析 Writer 的输出，更新 checkpoint data */
  private parseWriterOutput(raw: string): void {
    if (!this.data) return
    const lines = raw.split("\n")
    let currentKey = ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      if (trimmed.startsWith("SUMMARY:")) {
        this.data.summary = trimmed.slice(8).trim().slice(0, 500)
        currentKey = ""
      } else if (trimmed.startsWith("INTENT:")) {
        this.data.intent = trimmed.slice(7).trim().slice(0, 200)
        currentKey = ""
      } else if (trimmed.startsWith("ACTIVE_TASK:")) {
        this.data.activeTask = trimmed.slice(12).trim().slice(0, 200)
        currentKey = ""
      } else if (trimmed.startsWith("CURRENT_WORK:")) {
        this.data.currentWork = trimmed.slice(13).trim().slice(0, 200)
        currentKey = ""
      } else if (trimmed.startsWith("DECISIONS:")) { currentKey = "decisions"
      } else if (trimmed.startsWith("FILES:")) { currentKey = "files"
      } else if (trimmed.startsWith("FINDINGS:")) { currentKey = "findings"
      } else if (trimmed.startsWith("ERROR_FIXES:")) { currentKey = "errors"
      } else if (trimmed.startsWith("DESIGN:")) { currentKey = "design"
      } else if (trimmed.startsWith("TASKS:")) { currentKey = "tasks"
      } else if (trimmed.startsWith("PREFERENCES:")) { currentKey = "preferences"
      } else if (trimmed.startsWith("- ") && currentKey) {
        const value = trimmed.slice(2).trim()
        if (!value) continue
        switch (currentKey) {
          case "decisions":
            if (!this.data.recentDecisions.includes(value)) {
              this.data.recentDecisions.push(value)
            }
            break
          case "files":
            if (!this.data.keyFiles.includes(value)) {
              this.data.keyFiles.push(value)
            }
            break
          case "findings":
            if (!this.data.findings.includes(value)) {
              this.data.findings.push(value)
            }
            break
          case "errors":
            if (!this.data.errorFixes.includes(value)) {
              this.data.errorFixes.push(value)
            }
            break
          case "design":
            if (!this.data.designDecisions.includes(value)) {
              this.data.designDecisions.push(value)
            }
            break
          case "tasks":
            if (!this.data.taskTree.includes(value)) {
              this.data.taskTree.push(value)
            }
            break
          case "preferences":
            if (!this.data.userPreferences.includes(value)) {
              this.data.userPreferences.push(value)
            }
            break
        }
      }
    }

    // 裁剪到上限
    if (this.data.recentDecisions.length > MAX_RECENT_DECISIONS) this.data.recentDecisions = this.data.recentDecisions.slice(-MAX_RECENT_DECISIONS)
    if (this.data.keyFiles.length > MAX_KEY_FILES) this.data.keyFiles = this.data.keyFiles.slice(-MAX_KEY_FILES)
    if (this.data.findings.length > MAX_FINDINGS) this.data.findings = this.data.findings.slice(-MAX_FINDINGS)
    if (this.data.errorFixes.length > MAX_ERROR_FIXES) this.data.errorFixes = this.data.errorFixes.slice(-MAX_ERROR_FIXES)
    if (this.data.designDecisions.length > MAX_DESIGN_DECISIONS) this.data.designDecisions = this.data.designDecisions.slice(-MAX_DESIGN_DECISIONS)
    if (this.data.taskTree.length > MAX_TASK_TREE) this.data.taskTree = this.data.taskTree.slice(-MAX_TASK_TREE)
    if (this.data.userPreferences.length > MAX_USER_PREFERENCES) this.data.userPreferences = this.data.userPreferences.slice(-MAX_USER_PREFERENCES)
  }

  private createEmptyData(sessionId: string): CheckpointData {
    return {
      sessionId, workspace: "",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      summary: "", activeTask: "", recentDecisions: [], keyFiles: [],
      userPreferences: [], contextBudget: 0, intent: "", taskTree: [],
      currentWork: "", findings: [], errorFixes: [], designDecisions: [],
    }
  }

  private loadCheckpoint(sessionId: string, workspace: string): void {
    try {
      if (fs.existsSync(this.checkpointPath)) {
        const content = fs.readFileSync(this.checkpointPath, "utf-8")
        this.data = this.parseCheckpointMd(content)
        this.data.sessionId = sessionId
        this.data.workspace = workspace
      }
    } catch {
      this.data = null
    }
  }

  private saveCheckpoint(): void {
    if (!this.data) return
    try {
      const content = this.toCheckpointMd(this.data)
      fs.writeFileSync(this.checkpointPath, content, "utf-8")
    } catch { /* 静默 */ }
  }

  private parseCheckpointMd(content: string): CheckpointData {
    const data = this.createEmptyData("")
    const lines = content.split("\n")
    let currentSection = ""
    for (const line of lines) {
      if (line.startsWith("## Summary")) { currentSection = "summary"; continue }
      if (line.startsWith("## Active Task")) { currentSection = "task"; continue }
      if (line.startsWith("## Current Work")) { currentSection = "work"; continue }
      if (line.startsWith("## Intent")) { currentSection = "intent"; continue }
      if (line.startsWith("## Recent Decisions")) { currentSection = "decisions"; continue }
      if (line.startsWith("## Key Files")) { currentSection = "files"; continue }
      if (line.startsWith("## User Preferences")) { currentSection = "preferences"; continue }
      if (line.startsWith("## Task Tree")) { currentSection = "tasktree"; continue }
      if (line.startsWith("## Findings")) { currentSection = "findings"; continue }
      if (line.startsWith("## Error Fixes")) { currentSection = "errors"; continue }
      if (line.startsWith("## Design Decisions")) { currentSection = "design"; continue }
      if (line.startsWith("## Metadata")) { currentSection = "metadata"; continue }
      if (currentSection === "summary" && line.trim() && !line.startsWith("#")) {
        data.summary += (data.summary ? "\n" : "") + line.trim()
      } else if (currentSection === "task" && line.trim() && !line.startsWith("#")) {
        data.activeTask += (data.activeTask ? "\n" : "") + line.trim()
      } else if (currentSection === "work" && line.trim() && !line.startsWith("#")) {
        data.currentWork += (data.currentWork ? "\n" : "") + line.trim()
      } else if (currentSection === "intent" && line.trim() && !line.startsWith("#")) {
        data.intent += (data.intent ? "\n" : "") + line.trim()
      } else if (currentSection === "decisions" && line.trim().startsWith("- ")) {
        data.recentDecisions.push(line.trim().slice(2))
      } else if (currentSection === "files" && line.trim().startsWith("- ")) {
        data.keyFiles.push(line.trim().slice(2))
      } else if (currentSection === "preferences" && line.trim().startsWith("- ")) {
        data.userPreferences.push(line.trim().slice(2))
      } else if (currentSection === "tasktree" && line.trim().startsWith("- ")) {
        data.taskTree.push(line.trim().slice(2))
      } else if (currentSection === "findings" && line.trim().startsWith("- ")) {
        data.findings.push(line.trim().slice(2))
      } else if (currentSection === "errors" && line.trim().startsWith("- ")) {
        data.errorFixes.push(line.trim().slice(2))
      } else if (currentSection === "design" && line.trim().startsWith("- ")) {
        data.designDecisions.push(line.trim().slice(2))
      } else if (currentSection === "metadata") {
        if (line.includes("created:")) data.createdAt = line.split(":").slice(1).join(":").trim()
        if (line.includes("updated:")) data.updatedAt = line.split(":").slice(1).join(":").trim()
      }
    }
    return data
  }

  private toCheckpointMd(data: CheckpointData): string {
    const parts: string[] = [
      "# Session Checkpoint", "",
      "## Summary", data.summary || "(No summary yet)", "",
      "## Intent", data.intent || "(No intent set)", "",
      "## Active Task", data.activeTask || "(No active task)", "",
      "## Current Work", data.currentWork || "(Not currently working on anything)", "",
      "## Task Tree",
      ...(data.taskTree.length > 0 ? data.taskTree.slice(-MAX_TASK_TREE).map((t) => `- ${t}`) : ["- (No tasks)"]), "",
      "## Recent Decisions",
      ...(data.recentDecisions.length > 0 ? data.recentDecisions.slice(-MAX_RECENT_DECISIONS).map((d) => `- ${d}`) : ["- (No decisions recorded)"]), "",
      "## Key Files",
      ...(data.keyFiles.length > 0 ? data.keyFiles.slice(-MAX_KEY_FILES).map((f) => `- ${f}`) : ["- (No files recorded)"]), "",
      "## Findings",
      ...(data.findings.length > 0 ? data.findings.slice(-MAX_FINDINGS).map((f) => `- ${f}`) : ["- (No findings)"]), "",
      "## Error Fixes",
      ...(data.errorFixes.length > 0 ? data.errorFixes.slice(-MAX_ERROR_FIXES).map((e) => `- ${e}`) : ["- (No errors recorded)"]), "",
      "## Design Decisions",
      ...(data.designDecisions.length > 0 ? data.designDecisions.slice(-MAX_DESIGN_DECISIONS).map((d) => `- ${d}`) : ["- (No design decisions)"]), "",
      "## User Preferences",
      ...(data.userPreferences.length > 0 ? data.userPreferences.slice(-MAX_USER_PREFERENCES).map((p) => `- ${p}`) : ["- (No preferences)"]), "",
      "## Metadata",
      `- created: ${data.createdAt}`,
      `- updated: ${data.updatedAt}`,
    ]
    return parts.join("\n")
  }
}


