/**
 * 文件级记忆管理器 — 在 .memory/ 目录管理 MEMORY.md 索引
 * 替代 Python agent-backend/app/core/memory_manager.py
 */

import { join, relative } from "path"
import fs from "fs"
import type { MemoryProvider } from "./types"

const FORBIDDEN_PATTERNS = [
  /api[_-]?key/i, /secret/i, /token/i, /password/i,
  /private[_-]?key/i, /access[_-]?key/i,
  /sk-[a-zA-Z0-9]+/, /pk-[a-zA-Z0-9]+/,
]

export class FileMemoryProvider implements MemoryProvider {
  name = "file_memory"
  private memoryDir = ""
  private memoryFilePath = ""
  private memories: string[] = []

  async initialize(_sessionID: string, workspace: string): Promise<void> {
    this.memoryDir = join(workspace, ".memory")
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true })
    }
    this.memoryFilePath = join(this.memoryDir, "MEMORY.md")
    this.loadMemories()
  }

  buildSystemPrompt(): string {
    if (this.memories.length === 0) return ""
    return `[Memory: ${this.memories.length} saved facts available]`
  }

  async prefetch(_query: string, _sessionID: string): Promise<string> {
    if (this.memories.length === 0) return ""
    return (
      `<memory-context>\n` +
      `[File Memory recall from .memory/MEMORY.md]\n\n` +
      this.memories.slice(-10).map((m) => `- ${m}`).join("\n") +
      `\n</memory-context>`
    )
  }

  async syncTurn(user: string, assistant: string, _sessionID: string): Promise<void> {
    const facts = this.extractFacts(user, assistant)
    if (facts.length === 0) return

    for (const fact of facts) {
      if (!this.memories.includes(fact)) {
        this.memories.push(fact)
      }
    }

    if (this.memories.length > 200) {
      this.memories = this.memories.slice(-200)
    }

    this.saveMemories()
  }

  async shutdown(): Promise<void> {
    this.saveMemories()
  }

  private loadMemories(): void {
    try {
      if (fs.existsSync(this.memoryFilePath)) {
        const content = fs.readFileSync(this.memoryFilePath, "utf-8")
        this.memories = content
          .split("\n")
          .filter((l) => l.trim().startsWith("- "))
          .map((l) => l.trim().slice(2).trim())
      }
    } catch { this.memories = [] }
  }

  private saveMemories(): void {
    try {
      const content = [
        "# Memory",
        "",
        "Auto-generated from conversations. Updated on each turn.",
        "",
        ...this.memories.map((m) => `- ${m}`),
      ].join("\n")
      fs.writeFileSync(this.memoryFilePath, content, "utf-8")
    } catch { /* 静默 */ }
  }

  /** 批量接收提升的事实（来自 session 级记忆） */
  acceptPromotedFacts(facts: string[]): void {
    if (facts.length === 0) return
    let changed = false
    for (const f of facts) {
      if (!this.memories.includes(f)) {
        this.memories.push(f)
        changed = true
      }
    }
    if (changed) this.saveMemories()
  }

  private extractFacts(user: string, assistant: string): string[] {
    const facts: string[] = []
    const combined = `${user}\n${assistant}`

    // 提取决策
    const decisionMatch = combined.match(/(?:决定|计划|方案|改用|迁移|架构|技术选型)[：:]\s*(.+?)[。\n]/)
    if (decisionMatch) facts.push(`决策: ${decisionMatch[1].trim().slice(0, 100)}`)

    // 提取文件路径（排除临时/缓存文件）
    const pathMatches = combined.matchAll(/[`]([\w/\\\-_.]+\.[a-z]+)[`]/g)
    for (const m of pathMatches) {
      const path = m[1]
      if (path.includes("node_modules") || path.includes(".git") || path.includes("__pycache__")) continue
      if (!facts.includes(`文件: ${path}`)) facts.push(`文件: ${path}`)
    }

    // 提取配置更改
    const configMatch = combined.match(/(?:修改|添加|配置|设置)[了]?\s*(.+?)(?:为|到|成)\s*(.+?)[。\n]/)
    if (configMatch && !this.isSensitive(configMatch[0])) {
      facts.push(`配置: ${configMatch[0].trim().slice(0, 100)}`)
    }

    return facts.filter((f) => !this.isSensitive(f))
  }

  private isSensitive(text: string): boolean {
    return FORBIDDEN_PATTERNS.some((p) => p.test(text))
  }
}
