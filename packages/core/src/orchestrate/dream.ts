import * as fs from "fs"
import { join } from "path"
import { createLLMClient, type LLMMessage } from "../llm/client"
import { logError } from "../system/logger"
import type { DreamResult, GraphEntity, GraphRelationship, GraphStore, KnowledgeEntry, LLMConfig } from "./dream-types"
import { extractLightweightEntities, mergeGraphData, loadGraphStore, saveGraphStore } from "./dream-graph"
import { runDistill } from "./distill"

const DREAM_SYSTEM_PROMPT = `You are a knowledge extraction agent. Your task is to analyze conversation history and extract persistent knowledge that should be saved for future sessions.

Extract:
1. Project decisions and architecture choices
2. User preferences and coding style
3. Important file paths and their purposes
4. Configuration details
5. Lessons learned and best practices

ALSO extract graph entities and their relationships for knowledge graph visualization:
- Entities: key concepts, technologies, files, tools, decisions mentioned
- Relationships: how entities relate to each other (depends_on, contains, based_on, similar_to, etc.)

Also identify outdated or incorrect knowledge that should be removed.

Respond in JSON format:
{
  "knowledge": [
    {"content": "...", "tags": ["tag1", "tag2"]}
  ],
  "graph": {
    "entities": [
      {"name": "EntityName", "type": "concept|file|tool|decision", "description": "brief description"}
    ],
    "relationships": [
      {"source": "EntityA", "target": "EntityB", "relation": "depends_on|contains|based_on|similar_to|uses|implements|extends"}
    ]
  },
  "outdated": ["entry to remove"],
  "summary": "Brief summary of changes"
}`

export class DreamDistillManager {
  private knowledgeDir = ""
  private knowledgePath = ""
  private graphPath = ""
  private store: { entries: KnowledgeEntry[] } = { entries: [] }
  private graphStore: GraphStore = { entities: [], relationships: [] }
  private dreamHistory: DreamResult[] = []
  private distillHistory: Array<{ timestamp: string; workflowsFound: string[]; summary: string }> = []
  private turnCount = 0
  private autoDreamInterval = 15
  private pendingConversation: LLMMessage[] = []
  private llmConfig: LLMConfig | null = null

  async initialize(workspace: string): Promise<void> {
    this.knowledgeDir = join(workspace, ".mira", "knowledge")
    if (!fs.existsSync(this.knowledgeDir)) fs.mkdirSync(this.knowledgeDir, { recursive: true })
    this.knowledgePath = join(this.knowledgeDir, "knowledge.json")
    this.graphPath = join(this.knowledgeDir, "graph.json")
    this.loadStore()
    this.graphStore = loadGraphStore(this.graphPath)
  }

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config }

  recordTurn(user: string, assistant: string): void {
    this.turnCount++
    this.pendingConversation.push(
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    )
    if (this.pendingConversation.length > 30) this.pendingConversation = this.pendingConversation.slice(-30)

    const text = user + "\n" + assistant
    const { entities, relationships } = extractLightweightEntities(text, this.graphStore)
    if (entities.length > 0 || relationships.length > 0) {
      mergeGraphData(this.graphStore, entities, relationships)
      saveGraphStore(this.graphStore, this.graphPath)
    }
  }

  shouldAutoDream(): boolean {
    return this.turnCount > 0 && this.turnCount % this.autoDreamInterval === 0 && this.llmConfig !== null
  }

  async autoDream(): Promise<DreamResult | null> {
    if (!this.llmConfig || this.pendingConversation.length === 0) return null
    try {
      const result = await this.runDream(this.pendingConversation, this.llmConfig)
      this.pendingConversation = []
      return result
    } catch (err) {
      logError("[DreamDistillManager] Auto dream failed", err)
      return null
    }
  }

  async runDream(conversationHistory: LLMMessage[], config: LLMConfig): Promise<DreamResult> {
    const result: DreamResult = {
      timestamp: new Date().toISOString(),
      knowledgeExtracted: [],
      outdatedRemoved: [],
      summary: "",
    }

    try {
      const messages: LLMMessage[] = [
        { role: "system", content: DREAM_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Current knowledge base:\n${this.knowledgeToText()}\n\nConversation history:\n${formatConversation(conversationHistory)}\n\nExtract new knowledge and identify outdated entries.`,
        },
      ]

      const client = createLLMClient(config)
      let responseText = ""
      for await (const event of client.stream({ messages })) {
        if (event.type === "delta") responseText += event.delta
      }

      const parsed = this.parseDreamResponse(responseText)
      if (parsed.graph) {
        mergeGraphData(this.graphStore, parsed.graph.entities || [], parsed.graph.relationships || [])
        saveGraphStore(this.graphStore, this.graphPath)
      }

      for (const knowledge of parsed.knowledge) {
        const entry: KnowledgeEntry = {
          id: `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          content: knowledge.content,
          source: "dream",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: knowledge.tags || [],
        }
        this.store.entries.push(entry)
        result.knowledgeExtracted.push(knowledge.content)
      }

      for (const outdated of parsed.outdated) {
        const idx = this.store.entries.findIndex(e => e.content === outdated)
        if (idx !== -1) {
          this.store.entries.splice(idx, 1)
          result.outdatedRemoved.push(outdated)
        }
      }

      result.summary = parsed.summary || "Dream completed"
      this.dreamHistory.push(result)
      this.saveStore()
      this.writeMemoryMd()
    } catch (err) {
      logError("[DreamDistillManager] Dream failed", err)
      result.summary = `Dream failed: ${String(err)}`
    }

    return result
  }

  async distill(conversationHistory: LLMMessage[], config: LLMConfig): Promise<any> {
    const result = await runDistill(conversationHistory, config, this.knowledgeDir)
    this.distillHistory.push({ timestamp: result.timestamp, workflowsFound: result.workflowsFound.map(w => w.name), summary: result.summary })
    return result
  }

  getKnowledge(): KnowledgeEntry[] { return [...this.store.entries] }

  knowledgeToText(): string {
    if (this.store.entries.length === 0) return "(Empty knowledge base)"
    return this.store.entries.map(e => `- [${e.tags.join(", ")}] ${e.content}`).join("\n")
  }

  toSystemPrompt(): string {
    if (this.store.entries.length === 0) return ""
    const recent = this.store.entries.slice(-10)
    return `[Project knowledge]\n` + recent.map(e => `- ${e.content}`).join("\n")
  }

  toText(): string {
    const lines: string[] = ["# Dream/Distill"]
    lines.push("\n## Knowledge Base")
    lines.push(this.knowledgeToText())
    if (this.dreamHistory.length > 0) {
      lines.push("\n## Dream History")
      for (const d of this.dreamHistory.slice(-5)) {
        lines.push(`- [${d.timestamp}] ${d.summary} (${d.knowledgeExtracted.length} extracted, ${d.outdatedRemoved.length} removed)`)
      }
    }
    if (this.distillHistory.length > 0) {
      lines.push("\n## Distill History")
      for (const d of this.distillHistory.slice(-5)) {
        lines.push(`- [${d.timestamp}] ${d.summary} (${d.workflowsFound.length} workflows)`)
      }
    }
    return lines.join("\n")
  }

  getGraphData(): any { return { ...this.graphStore } }

  private parseDreamResponse(text: string): { knowledge: Array<{ content: string; tags: string[] }>; graph?: { entities: GraphEntity[]; relationships: GraphRelationship[] }; outdated: string[]; summary: string } {
    try {
      const cleaned = text.replace(/```(?:json)?\n?/g, "").trim()
      const parsed = JSON.parse(cleaned)
      return {
        knowledge: parsed.knowledge || [],
        graph: parsed.graph,
        outdated: parsed.outdated || [],
        summary: parsed.summary || "",
      }
    } catch {
      return { knowledge: [], outdated: [], summary: "Failed to parse dream response" }
    }
  }

  private loadStore(): void {
    try {
      if (fs.existsSync(this.knowledgePath)) this.store = JSON.parse(fs.readFileSync(this.knowledgePath, "utf-8"))
    } catch { this.store = { entries: [] } }
  }

  private saveStore(): void {
    try { fs.writeFileSync(this.knowledgePath, JSON.stringify(this.store, null, 2), "utf-8") } catch { /* 静默 */ }
  }

  private writeMemoryMd(): void {
    try {
      const mdPath = join(this.knowledgeDir, "MEMORY.md")
      const content = ["# Memory", "", ...this.store.entries.map(e => `- ${e.content}`)].join("\n")
      fs.writeFileSync(mdPath, content, "utf-8")
    } catch { /* 静默 */ }
  }
}

function formatConversation(messages: LLMMessage[]): string {
  return messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => `[${m.role}]\n${typeof m.content === "string" ? m.content.slice(0, 500) : ""}`)
    .join("\n\n")
}
