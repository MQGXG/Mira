/**
 * 知识图谱管理工具
 * Agent 可主动管理知识图谱（添加节点、边、查询社区等）
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { getDynamicMemoryManager } from "./memory-activate"
import { calculateStrength } from "../../memory/memory-strength"
import type { MemoryType } from "../../memory/memory-node"
import { logError } from "../../system/logger"

export const memoryGraphAddNodeTool = make({
  name: "memory_graph_add_node",
  description: "Add a concept or memory to the knowledge graph. Use this to explicitly store important information, decisions, or relationships discovered during work.",
  inputSchema: z.object({
    id: z.string().describe("Unique identifier for the memory node (e.g., 'electron-builder', 'api-design', 'bug-fix-123')"),
    content: z.string().describe("Memory content - what should be remembered about this concept"),
    type: z.enum(["semantic", "episodic", "procedural", "declarative"]).optional().describe("Memory type: 'semantic' for facts/knowledge, 'episodic' for events/experiences, 'procedural' for how-to/processes, 'declarative' for definitions"),
    importance: z.number().optional().describe("Importance level (0-1, default: 0.5). Higher importance means slower decay."),
    decayProfile: z.enum(["core_code", "documentation", "temp_notes", "decisions", "episodic"]).optional().describe("Decay profile: 'core_code' for long-lived code knowledge, 'documentation' for medium-term, 'temp_notes' for short-term, 'decisions' for important choices"),
  }),
  outputSchema: z.string(),
  permission: "write",

  async execute(input, ctx) {
    const mgr = getDynamicMemoryManager()
    if (!mgr) {
      return { success: false, error: "Dynamic memory system not initialized" }
    }

    try {
      const node = await mgr.addNode(
        input.id,
        input.content,
        (input.type || "semantic"),
        input.decayProfile || "documentation"
      )

      // 设置重要性
      if (input.importance !== undefined) {
        node.importance = Math.max(0, Math.min(1, input.importance))
      }

      return {
        success: true,
        output: `Added memory node "${input.id}" to knowledge graph.\nType: ${node.type}\nImportance: ${node.importance}\nDecay profile: ${node.decayConfig.decayRate}`,
      }
    } catch (err) {
      logError("[MemoryGraph] Add node failed", err)
      return {
        success: false,
        error: `Failed to add node: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})

export const memoryGraphAddEdgeTool = make({
  name: "memory_graph_add_edge",
  description: "Add a relationship between two concepts in the knowledge graph. Use this to explicitly link related ideas, code components, or decisions.",
  inputSchema: z.object({
    source: z.string().describe("Source concept ID"),
    target: z.string().describe("Target concept ID"),
    relation: z.string().describe("Relationship type (e.g., 'depends_on', 'related_to', 'implements', 'calls', 'imports')"),
    strength: z.number().optional().describe("Relationship strength (0-1, default: 0.5). Higher means stronger association."),
  }),
  outputSchema: z.string(),
  permission: "write",

  async execute(input, ctx) {
    const mgr = getDynamicMemoryManager()
    if (!mgr) {
      return { success: false, error: "Dynamic memory system not initialized" }
    }

    try {
      // 确保图谱已从 SQLite 加载（检查节点存在性前）
      await mgr.ensureInit()
      // 检查节点是否存在
      const graph = mgr.getGraph()
      if (!graph.nodes.has(input.source)) {
        return { success: false, error: `Source node "${input.source}" not found. Add it first with memory_graph_add_node.` }
      }
      if (!graph.nodes.has(input.target)) {
        return { success: false, error: `Target node "${input.target}" not found. Add it first with memory_graph_add_node.` }
      }

      const edge = await mgr.addEdge(
        input.source,
        input.target,
        input.relation,
        Math.max(0, Math.min(1, input.strength || 0.5))
      )

      return {
        success: true,
        output: `Added relationship: ${input.source} → ${input.target}\nRelation: ${input.relation}\nStrength: ${edge.strength.toFixed(2)}`,
      }
    } catch (err) {
      logError("[MemoryGraph] Add edge failed", err)
      return {
        success: false,
        error: `Failed to add edge: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})

export const memoryGraphQueryTool = make({
  name: "memory_graph_query",
  description: "Query the knowledge graph for information about a concept, its relationships, or community structure.",
  inputSchema: z.object({
    query: z.string().describe("Query - can be a concept ID, or natural language question"),
    type: z.enum(["node", "neighbors", "communities", "stats"]).optional().describe("Query type: 'node' for specific concept, 'neighbors' for related concepts, 'communities' for graph clusters, 'stats' for overall statistics"),
  }),
  outputSchema: z.string(),
  permission: "read",

  async execute(input, ctx) {
    const mgr = getDynamicMemoryManager()
    if (!mgr) {
      return { success: false, error: "Dynamic memory system not initialized" }
    }

    try {
      // 确保图谱已从 SQLite 加载（避免查询空图）
      await mgr.ensureInit()
      const graph = mgr.getGraph()
      const queryType = input.type || "node"

      switch (queryType) {
        case "node": {
          const node = graph.nodes.get(input.query)
          if (!node) {
            return { success: false, error: `Node "${input.query}" not found in knowledge graph.` }
          }

          const strength = calculateStrength(node)
          const lines = [
            `Node: ${node.id}`,
            `Content: ${node.content.slice(0, 200)}`,
            `Type: ${node.type}`,
            `Strength: ${strength.toFixed(2)}`,
            `Importance: ${node.importance.toFixed(2)}`,
            `Access count: ${node.accessCount}`,
            `Related nodes: ${node.relatedNodes.length}`,
            node.communityId ? `Community: ${node.communityId}` : "",
          ].filter(Boolean)

          return { success: true, output: lines.join("\n") }
        }

        case "neighbors": {
          const node = graph.nodes.get(input.query)
          if (!node) {
            return { success: false, error: `Node "${input.query}" not found.` }
          }

          const neighbors = node.relatedNodes
            .map(id => graph.nodes.get(id))
            .filter(Boolean)
            .slice(0, 10)

          if (neighbors.length === 0) {
            return { success: true, output: `No neighbors found for "${input.query}".` }
          }

          const lines = [`Connections for ${input.query} (${neighbors.length}):`]
          for (const n of neighbors) {
            const strength = node.associationStrengths.get(n!.id) || 0
            lines.push(`  ${n!.id} (${strength.toFixed(2)}) - ${n!.content.slice(0, 80)}`)
          }

          return { success: true, output: lines.join("\n") }
        }

        case "communities": {
          const stats = mgr.getCommunityStats()
          if (stats.length === 0) {
            return { success: true, output: "No communities detected yet. Add more nodes to enable community detection." }
          }

          const lines = ["Communities:"]
          for (const s of stats) {
            lines.push(`  ${s.name}: ${s.count} nodes (avg strength: ${s.avgStrength.toFixed(2)})`)
          }

          return { success: true, output: lines.join("\n") }
        }

        case "stats": {
          const lines = [
            `Total nodes: ${graph.nodes.size}`,
            `Total edges: ${graph.edges.length}`,
            `Total communities: ${graph.metadata.totalCommunities}`,
            `Last updated: ${graph.metadata.lastUpdated}`,
          ]

          return { success: true, output: lines.join("\n") }
        }

        default:
          return { success: false, error: `Unknown query type: ${queryType}` }
      }
    } catch (err) {
      logError("[MemoryGraph] Query failed", err)
      return {
        success: false,
        error: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})

export const memoryGraphDecayTool = make({
  name: "memory_graph_decay",
  description: "Perform maintenance on the knowledge graph: decay weak memories and consolidate strong ones. Run periodically to keep the graph healthy.",
  inputSchema: z.object({
    action: z.enum(["decay", "consolidate", "stats"]).optional().describe("Action to perform: 'decay' to forget weak memories, 'consolidate' to strengthen frequent ones, 'stats' for current state"),
  }),
  outputSchema: z.string(),
  permission: "write",

  async execute(input, ctx) {
    const mgr = getDynamicMemoryManager()
    if (!mgr) {
      return { success: false, error: "Dynamic memory system not initialized" }
    }

    try {
      const action = input.action || "stats"

      // 确保图谱已从 SQLite 加载
      await mgr.ensureInit()

      switch (action) {
        case "decay": {
          const forgotten = await mgr.performDecay()
          return {
            success: true,
            output: `Decay completed. ${forgotten} memories were weakened to minimum strength.`,
          }
        }

        case "consolidate": {
          const consolidated = await mgr.performConsolidation()
          return {
            success: true,
            output: `Consolidation completed. ${consolidated} memories were strengthened.`,
          }
        }

        case "stats": {
          const graph = mgr.getGraph()
          const lines = [
            "Knowledge Graph Statistics:",
            `  Nodes: ${graph.nodes.size}`,
            `  Edges: ${graph.edges.length}`,
            `  Communities: ${graph.metadata.totalCommunities}`,
          ]

          // 强度分布
          const nodes = Array.from(graph.nodes.values())
          const strong = nodes.filter(n => n.strength > 0.7).length
          const medium = nodes.filter(n => n.strength >= 0.3 && n.strength <= 0.7).length
          const weak = nodes.filter(n => n.strength < 0.3).length

          lines.push(`  Strength distribution: ${strong} strong, ${medium} medium, ${weak} weak`)

          return { success: true, output: lines.join("\n") }
        }

        default:
          return { success: false, error: `Unknown action: ${action}` }
      }
    } catch (err) {
      logError("[MemoryGraph] Maintenance failed", err)
      return {
        success: false,
        error: `Maintenance failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  },
})
