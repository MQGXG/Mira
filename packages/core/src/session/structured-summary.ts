/**
 * 结构化摘要 — 对标 opencode 的 Compaction 结构化模板
 *
 * 替代自由文本摘要，使用 Objective/Work State/Next Move/Files/Details 格式。
 * 支持增量更新（仅更新变化的 sections）和溢出触发压缩。
 */

import type { LLMMessage, ContentPart, TextPart } from "../llm/schema/messages"
import { createLLMClient } from "../llm/client"

// ── 类型定义 ────────────────────────────────────────────

/** 结构化摘要 */
export interface StructuredSummary {
  /** 当前目标 */
  objective: string
  /** 关键发现/细节 */
  details: string[]
  /** 工作状态（进度、当前步骤） */
  workState: string
  /** 下一步计划 */
  nextMove: string
  /** 关键文件列表 */
  files: string[]
  /** 用户约束/偏好 */
  constraints: string[]
  /** 生成时间戳 */
  generatedAt: string
}

/** LLM 配置 */
export interface SummaryLLMConfig {
  apiKey: string
  apiUrl: string
  model: string
  provider: string
}

// ── 工具函数 ────────────────────────────────────────────

function extractText(msg: LLMMessage): string {
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text || "")
      .join("")
  }
  return ""
}

function extractFiles(messages: LLMMessage[]): string[] {
  const files: string[] = []
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" && part.args) {
        const args = part.args
        if (typeof args.path === "string" && args.path) files.push(args.path)
        if (typeof args.file_path === "string" && args.file_path) files.push(args.file_path)
      }
    }
  }
  return [...new Set(files)]
}

function formatSummary(s: StructuredSummary): string {
  const lines: string[] = [
    "## Objective",
    s.objective,
    "",
    "## Work State",
    s.workState,
    "",
    "## Next Move",
    s.nextMove,
  ]

  if (s.details.length > 0) {
    lines.push("", "## Details")
    s.details.forEach(d => lines.push(`- ${d}`))
  }

  if (s.files.length > 0) {
    lines.push("", "## Relevant Files")
    s.files.forEach(f => lines.push(`- ${f}`))
  }

  if (s.constraints.length > 0) {
    lines.push("", "## Constraints")
    s.constraints.forEach(c => lines.push(`- ${c}`))
  }

  return lines.join("\n")
}

// ── IncrementalSummarizer ────────────────────────────────

export class IncrementalSummarizer {
  private currentSummary: StructuredSummary | null = null
  private turnCount = 0
  private updateInterval = 5
  private llmConfig: SummaryLLMConfig | null = null

  setLLMConfig(config: SummaryLLMConfig): void {
    this.llmConfig = config
  }

  getCurrentSummary(): StructuredSummary | null {
    return this.currentSummary
  }

  /**
   * 增量更新摘要 — 仅更新受影响的 sections
   */
  async update(messages: LLMMessage[]): Promise<StructuredSummary> {
    this.turnCount++

    // 非 LLM 模式：简单提取
    if (!this.llmConfig || this.turnCount % this.updateInterval !== 0) {
      if (this.currentSummary) {
        const newFiles = extractFiles(messages)
        const newDetails = this.extractRecentDetails(messages)
        this.currentSummary = {
          ...this.currentSummary,
          details: [...this.currentSummary.details, ...newDetails].slice(-10),
          files: [...new Set([...this.currentSummary.files, ...newFiles])].slice(-15),
          generatedAt: new Date().toISOString(),
        }
        return this.currentSummary
      }
    }

    // LLM 增量摘要
    if (this.llmConfig) {
      this.currentSummary = await this.incrementalLLMSummary(messages, this.currentSummary)
    } else {
      this.currentSummary = this.fullRebuild(messages)
    }

    return this.currentSummary
  }

  /**
   * LLM 增量摘要 — 仅发送变化部分给 LLM
   */
  async incrementalLLMSummary(
    messages: LLMMessage[],
    previousSummary: StructuredSummary | null,
  ): Promise<StructuredSummary> {
    if (!previousSummary) return this.fullRebuild(messages)

    // 提取最近 10 条的变化
    const recentMessages = messages.slice(-10)
    const recentText = recentMessages.map(m => {
      const content = extractText(m)
      return `${m.role}: ${content.slice(0, 500)}`
    }).join("\n")

    const prompt = `You are updating a structured summary. Only update the sections that changed.

CURRENT SUMMARY:
Objective: ${previousSummary.objective}
Work State: ${previousSummary.workState}
Next Move: ${previousSummary.nextMove}
Files: ${previousSummary.files.join(", ")}
Details: ${previousSummary.details.join("; ")}
Constraints: ${previousSummary.constraints.join("; ")}

RECENT CONVERSATION:
${recentText}

Respond in this EXACT format (update only changed sections, keep unchanged ones as-is):
OBJECTIVE: <updated objective>
WORK_STATE: <updated work state>
NEXT_MOVE: <updated next move>
FILES: <comma-separated file list>
DETAILS: <semicolon-separated details>
CONSTRAINTS: <semicolon-separated constraints>`

    try {
      const client = createLLMClient({
        provider: this.llmConfig!.provider,
        model: this.llmConfig!.model,
        apiKey: this.llmConfig!.apiKey,
        apiUrl: this.llmConfig!.apiUrl,
      })

      const result = await client.complete({
        messages: [{ role: "user", content: prompt }],
      })

      const text = typeof result.content === "string"
        ? result.content
        : Array.isArray(result.content)
          ? (result.content as unknown as ContentPart[]).filter((p): p is TextPart => p.type === "text").map((p) => p.text).join("")
          : ""

      return this.parseStructuredResponse(text, previousSummary)
    } catch {
      return previousSummary
    }
  }

  /**
   * 溢出触发压缩 — 上下文超限时的应急策略
   */
  overflowCompact(
    messages: LLMMessage[],
    summary: StructuredSummary,
    maxTokens: number,
  ): LLMMessage[] {
    const system = messages.find(m => m.role === "system")
    const recentCount = 6
    const recent = messages.slice(-recentCount)

    const summaryText = formatSummary(summary)

    return [
      ...(system ? [system] : []),
      { role: "user" as const, content: `[Context Overflow — Structured Summary]\n\n${summaryText}` },
      ...recent,
    ]
  }

  /**
   * 格式化摘要为文本（供外部使用）
   */
  formatSummary(s: StructuredSummary): string {
    return formatSummary(s)
  }

  /**
   * 从 LLM 响应中提取结构化摘要（供 CheckpointProvider 使用）
   */
  buildFromLLMResponse(summaryText: string): StructuredSummary {
    return this.parseStructuredResponse(summaryText, this.emptySummary())
  }

  // ── 私有方法 ──────────────────────────────────────────

  private extractRecentDetails(messages: LLMMessage[]): string[] {
    const newDetails: string[] = []
    const recent = messages.slice(-6)
    for (const msg of recent) {
      if (msg.role === "assistant") {
        const text = extractText(msg).slice(0, 200)
        if (text.length > 20) newDetails.push(text)
      }
    }
    return newDetails.slice(-3)
  }

  private fullRebuild(messages: LLMMessage[]): StructuredSummary {
    const userMessages = messages.filter(m => m.role === "user")
    const objective = userMessages[0]
      ? extractText(userMessages[0]).slice(0, 200)
      : "Unknown objective"

    return {
      objective,
      details: [],
      workState: `Turn ${this.turnCount}`,
      nextMove: "Continue working",
      files: extractFiles(messages),
      constraints: [],
      generatedAt: new Date().toISOString(),
    }
  }

  private parseStructuredResponse(
    response: string,
    fallback: StructuredSummary,
  ): StructuredSummary {
    const sections: Record<string, string> = {}
    for (const line of response.split("\n")) {
      const match = line.match(/^(OBJECTIVE|WORK_STATE|NEXT_MOVE|FILES|DETAILS|CONSTRAINTS):\s*(.*)$/)
      if (match) {
        sections[match[1]] = match[2]
      }
    }

    return {
      objective: sections["OBJECTIVE"] || fallback.objective,
      workState: sections["WORK_STATE"] || fallback.workState,
      nextMove: sections["NEXT_MOVE"] || fallback.nextMove,
      files: sections["FILES"] ? sections["FILES"].split(",").map(f => f.trim()).filter(Boolean) : fallback.files,
      details: sections["DETAILS"] ? sections["DETAILS"].split(";").map(d => d.trim()).filter(Boolean) : fallback.details,
      constraints: sections["CONSTRAINTS"] ? sections["CONSTRAINTS"].split(";").map(c => c.trim()).filter(Boolean) : fallback.constraints,
      generatedAt: new Date().toISOString(),
    }
  }

  private emptySummary(): StructuredSummary {
    return {
      objective: "",
      details: [],
      workState: "",
      nextMove: "",
      files: [],
      constraints: [],
      generatedAt: new Date().toISOString(),
    }
  }

  // ── 与 CheckpointData 互转 ────────────────────────────

  /**
   * 从 CheckpointData 转换为 StructuredSummary
   * 兼容现有 checkpoint-provider.ts 的数据格式
   */
  static fromCheckpointData(data: {
    summary?: string
    intent?: string
    activeTask?: string
    currentWork?: string
    recentDecisions?: string[]
    keyFiles?: string[]
    findings?: string[]
    errorFixes?: string[]
    designDecisions?: string[]
    userPreferences?: string[]
  }): StructuredSummary {
    return {
      objective: data.intent || data.summary || "",
      details: [
        ...(data.findings || []),
        ...(data.errorFixes || []),
        ...(data.designDecisions || []),
      ],
      workState: data.currentWork || data.activeTask || "",
      nextMove: data.activeTask || "",
      files: data.keyFiles || [],
      constraints: data.userPreferences || [],
      generatedAt: new Date().toISOString(),
    }
  }

  /**
   * 转换为 CheckpointData 格式（供 checkpoint-provider 使用）
   */
  toCheckpointData(summary: StructuredSummary): {
    summary: string
    intent: string
    activeTask: string
    currentWork: string
    recentDecisions: string[]
    keyFiles: string[]
    findings: string[]
    errorFixes: string[]
    designDecisions: string[]
    userPreferences: string[]
  } {
    return {
      summary: summary.objective,
      intent: summary.objective,
      activeTask: summary.nextMove,
      currentWork: summary.workState,
      recentDecisions: summary.details,
      keyFiles: summary.files,
      findings: summary.details.filter(d => !d.startsWith("[fix]") && !d.startsWith("[design]")),
      errorFixes: summary.details.filter(d => d.startsWith("[fix]")).map(d => d.slice(5)),
      designDecisions: summary.details.filter(d => d.startsWith("[design]")).map(d => d.slice(9)),
      userPreferences: summary.constraints,
    }
  }
}
