/**
 * 动态记忆激活工具
 * Agent 可主动调用 memory_activate 进行图谱激活传播
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import type { DynamicMemoryManager} from "../../memory/dynamic-memory";
import { createDynamicMemory } from "../../memory/dynamic-memory"
import { simpleTextRelevance, semanticRelevance } from "../../memory/memory-activation"
import { calculateStrength } from "../../memory/memory-strength"
import type { MemoryNode } from "../../memory/memory-node"
import { logError } from "../../system/logger"

/** 模块级单例，由 agent.ts 初始化时注入 */
let memoryManager: DynamicMemoryManager | null = null

export function setDynamicMemoryManager(m: DynamicMemoryManager): void {
  memoryManager = m
}

export function getDynamicMemoryManager(): DynamicMemoryManager | null {
  return memoryManager
}

/** 创建新实例（用于测试） */
export function createDynamicMemoryManager(): DynamicMemoryManager {
  return createDynamicMemory()
}

export const memoryActivateTool = make({
  name: "memory_activate",
  description: "Activate related memories from the knowledge graph using neural propagation. Use this when you need to find connected concepts, trace relationships between code components, or discover insights through graph traversal. Unlike simple search, this explores associations and can trigger spontaneous recall of weakly-connected memories.",
  inputSchema: z.object({
    query: z.string().describe("Query to activate memories - can be a concept, function name, or natural language question"),
    depth: z.number().optional().describe("Maximum propagation depth (default: 3, max: 5)"),
    relevance: z.enum(["simple", "semantic"]).optional().describe("Relevance function: 'simple' for keyword matching (faster), 'semantic' for TF-IDF similarity (more accurate)"),
    limit: z.number().optional().describe("Maximum results to return (default: 10, max: 20)"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const mgr = getDynamicMemoryManager()
    if (!mgr) {
      return { success: false, error: "Dynamic memory system not initialized" }
    }

    const depth = Math.min(input.depth || 3, 5)
    const limit = Math.min(input.limit || 10, 20)
    const relevanceFn = input.relevance === "semantic" ? semanticRelevance : simpleTextRelevance

    try {
      // 执行激活
      const result = await mgr.activate(input.query, relevanceFn)

      if (result.nodes.length === 0) {
        return {
          success: true,
          output: `No related memories found for "${input.query}". The knowledge graph learns as you work - relevant concepts are extracted from conversations and code.`,
        }
      }

      // 格式化输出
      const lines: string[] = []

      if (result.spontaneousRecall) {
        lines.push("✨ Spontaneous recall triggered - weak memories activated through strong associations\n")
      }

      lines.push(`Activated ${result.nodes.length} related memories:\n`)

      for (const node of result.nodes.slice(0, limit)) {
        const strength = calculateStrength(node)
        const strengthBar = "█".repeat(Math.round(strength * 10))
        const typeIcon = {
          semantic: "📚",
          episodic: "💭",
          procedural: "⚙️",
          declarative: "📝",
        }[node.type] || "📚"

        lines.push(`${typeIcon} ${node.id} [${strengthBar}] ${strength.toFixed(2)}`)
        lines.push(`   ${node.content.slice(0, 120)}${node.content.length > 120 ? "..." : ""}`)
        lines.push("")
      }

      // 显示激活路径
      if (result.paths.length > 0) {
        lines.push("Activation paths:")
        for (const path of result.paths.slice(0, 5)) {
          lines.push(`  ${path.from} → ${path.to} (${path.strength.toFixed(2)})`)
        }
        lines.push("")
      }

      lines.push(`Activation strength: ${result.activationStrength.toFixed(2)}`)

      return { success: true, output: lines.join("\n") }
    } catch (err) {
      logError("[MemoryActivate] Activation failed", err)
      return {
        success: false,
        error: `Memory activation failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})
