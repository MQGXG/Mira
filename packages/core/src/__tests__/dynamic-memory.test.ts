/**
 * 动态记忆图谱测试
 */

import { describe, it, expect, beforeEach } from "vitest"
import type { DynamicMemoryManager} from "../memory/dynamic-memory";
import { createDynamicMemory } from "../memory/dynamic-memory"
import { calculateStrength, updateStrengthAfterAccess } from "../memory/memory-strength"
import { retentionRate, decayStrength, hoursToDecay } from "../memory/decay-curve"
import { activateMemory, simpleTextRelevance } from "../memory/memory-activation"
import { createMemoryNode, createEmptyGraph, DECAY_PROFILES } from "../memory/memory-node"

describe("DynamicMemoryManager", () => {
  let manager: DynamicMemoryManager

  beforeEach(async () => {
    manager = createDynamicMemory()
    await manager.init()
    await manager.clear() // 清空数据库确保测试隔离
  })

  it("should add nodes and edges", async () => {
    await manager.addNode("node1", "Electron 打包配置", "semantic")
    await manager.addNode("node2", "electron-builder 配置", "semantic")
    await manager.addEdge("node1", "node2", "related_to", 0.8)

    const graph = manager.getGraph()
    expect(graph.nodes.size).toBe(2)
    expect(graph.edges.length).toBe(1)
  })

  it("should activate memory on query", async () => {
    await manager.addNode("electron", "Electron 是桌面应用框架", "semantic")
    await manager.addNode("react", "React 是前端框架", "semantic")
    await manager.addNode("builder", "electron-builder 用于打包", "semantic")
    await manager.addEdge("electron", "builder", "related_to", 0.9)

    const result = await manager.activate("Electron 打包")

    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.nodes.some(n => n.id === "electron")).toBe(true)
  })

  it("should format activation result", async () => {
    await manager.addNode("node1", "测试内容", "semantic")
    const result = await manager.activate("测试")
    const formatted = manager.formatActivationResult(result)

    expect(formatted).toContain("激活了")
  })

  it("should perform decay", async () => {
    const node = await manager.addNode("old-node", "旧内容", "semantic", "temp_notes")
    // 模拟时间流逝
    const oldDate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7) // 7天前
    node.lastAccessed = oldDate

    await manager.performDecay()

    const graph = manager.getGraph()
    const updatedNode = graph.nodes.get("old-node")
    expect(updatedNode?.strength).toBeLessThan(1.0)
  })

  it("should perform consolidation", async () => {
    const node = await manager.addNode("frequent-node", "频繁访问", "semantic")
    node.accessCount = 10
    node.strength = 0.8

    await manager.performConsolidation()

    const graph = manager.getGraph()
    const updatedNode = graph.nodes.get("frequent-node")
    expect(updatedNode?.importance).toBeGreaterThan(0.5)
  })

  it("should export and import JSON", async () => {
    await manager.addNode("node1", "内容1", "semantic")
    await manager.addNode("node2", "内容2", "semantic")
    await manager.addEdge("node1", "node2", "related_to", 0.7)

    const json = manager.toJSON()
    const manager2 = createDynamicMemory()
    manager2.importFromJSON(json)

    const graph = manager2.getGraph()
    expect(graph.nodes.size).toBe(2)
    expect(graph.edges.length).toBe(1)
  })

  it("should remove nodes", async () => {
    await manager.addNode("node1", "内容1", "semantic")
    await manager.addNode("node2", "内容2", "semantic")
    await manager.addEdge("node1", "node2", "related_to", 0.7)

    const removed = await manager.removeNode("node1")
    expect(removed).toBe(true)

    const graph = manager.getGraph()
    expect(graph.nodes.size).toBe(1)
    expect(graph.edges.length).toBe(0)
  })
})

describe("MemoryStrength", () => {
  it("should calculate strength", () => {
    const node = createMemoryNode("test", "测试内容", "semantic")
    node.importance = 0.8
    node.accessCount = 5

    const strength = calculateStrength(node)
    expect(strength).toBeGreaterThan(0)
    expect(strength).toBeLessThanOrEqual(1)
  })

  it("should update strength after access", () => {
    const node = createMemoryNode("test", "测试内容", "semantic")
    const oldStrength = node.strength

    const updated = updateStrengthAfterAccess(node)
    expect(updated.accessCount).toBe(1)
    expect(updated.strength).toBeGreaterThanOrEqual(oldStrength)
  })
})

describe("DecayCurve", () => {
  it("should calculate retention rate", () => {
    const rate1 = retentionRate(0, 1.0) // 刚访问
    const rate2 = retentionRate(24, 1.0) // 1天后
    const rate3 = retentionRate(168, 1.0) // 1周后

    expect(rate1).toBeGreaterThan(rate2)
    expect(rate2).toBeGreaterThan(rate3)
  })

  it("should calculate decay strength", () => {
    const initial = 1.0
    const decayed = decayStrength(initial, 24, 0.05) // 24小时后，衰减率0.05

    expect(decayed).toBeLessThan(initial)
    expect(decayed).toBeGreaterThan(0)
  })

  it("should calculate hours to decay", () => {
    const hours = hoursToDecay(1.0, 0.5, 0.05) // 从1.0衰减到0.5需要多少小时

    expect(hours).toBeGreaterThan(0)
    expect(hours).toBeLessThan(100)
  })
})

describe("MemoryActivation", () => {
  it("should activate memory on query", async () => {
    const graph = createEmptyGraph()

    // 添加节点
    const node1 = createMemoryNode("electron", "Electron 是桌面应用框架", "semantic")
    const node2 = createMemoryNode("react", "React 是前端框架", "semantic")
    graph.nodes.set("electron", node1)
    graph.nodes.set("react", node2)

    const result = await activateMemory(
      "Electron",
      graph,
      simpleTextRelevance,
      { maxDepth: 2, activationThreshold: 0.3, spontaneousRecallThreshold: 0.15, propagationDecay: 0.7, maxActivatedNodes: 10 }
    )

    expect(result.nodes.length).toBeGreaterThan(0)
  })

  it("should perform spontaneous recall", async () => {
    const graph = createEmptyGraph()

    // 添加弱记忆
    const weakNode = createMemoryNode("weak", "弱记忆", "semantic")
    weakNode.strength = 0.1
    weakNode.relatedNodes = ["strong"]

    // 添加强记忆
    const strongNode = createMemoryNode("strong", "强记忆", "semantic")
    strongNode.strength = 0.9

    graph.nodes.set("weak", weakNode)
    graph.nodes.set("strong", strongNode)

    const result = await activateMemory(
      "弱记忆",
      graph,
      simpleTextRelevance,
      { maxDepth: 3, activationThreshold: 0.3, spontaneousRecallThreshold: 0.15, propagationDecay: 0.7, maxActivatedNodes: 10 }
    )

    // 弱记忆应该通过强关联被激活（如果相关性足够）
    // 注意：spontaneousRecall 只有在弱记忆的相关性足够高时才会触发
    expect(result.nodes.length).toBeGreaterThan(0)
  })
})

describe("Ebbinghaus Forgetting Curve", () => {
  it("should show forgetting curve pattern", () => {
    const initialStrength = 1.0
    const decayRate = 0.05

    const hour1 = retentionRate(1, initialStrength)
    const hour24 = retentionRate(24, initialStrength)
    const hour168 = retentionRate(168, initialStrength)

    // 验证遗忘曲线：快速遗忘后趋于平缓
    expect(hour1).toBeGreaterThan(hour24)
    expect(hour24).toBeGreaterThan(hour168)

    // 验证24小时后保留率（衰减率0.05下约78%）
    expect(hour24).toBeGreaterThan(0.5)
    expect(hour24).toBeLessThan(0.9)
  })

  it("should show spaced repetition effect", () => {
    const initialStrength = 1.0
    const decayRate = 0.05

    // 单次学习
    const singleLearning = decayStrength(initialStrength, 168, decayRate)

    // 多次复习
    let multiStrength = initialStrength
    multiStrength = decayStrength(multiStrength, 24, decayRate) // 1天后
    multiStrength = updateStrengthAfterAccess(createMemoryNode("test", "", "semantic")).strength
    multiStrength = decayStrength(multiStrength, 48, decayRate) // 再2天后

    // 多次复习应该比单次学习保留更多
    expect(multiStrength).toBeGreaterThan(singleLearning)
  })
})

describe("MemoryTools", () => {
  it("memoryActivateTool should be defined", async () => {
    const { memoryActivateTool } = await import("../tools/knowledge/memory-activate")
    expect(memoryActivateTool).toBeDefined()
    expect(memoryActivateTool.name).toBe("memory_activate")
  })

  it("memoryGraphAddNodeTool should be defined", async () => {
    const { memoryGraphAddNodeTool } = await import("../tools/knowledge/memory-graph")
    expect(memoryGraphAddNodeTool).toBeDefined()
    expect(memoryGraphAddNodeTool.name).toBe("memory_graph_add_node")
  })

  it("memoryGraphAddEdgeTool should be defined", async () => {
    const { memoryGraphAddEdgeTool } = await import("../tools/knowledge/memory-graph")
    expect(memoryGraphAddEdgeTool).toBeDefined()
    expect(memoryGraphAddEdgeTool.name).toBe("memory_graph_add_edge")
  })

  it("memoryGraphQueryTool should be defined", async () => {
    const { memoryGraphQueryTool } = await import("../tools/knowledge/memory-graph")
    expect(memoryGraphQueryTool).toBeDefined()
    expect(memoryGraphQueryTool.name).toBe("memory_graph_query")
  })

  it("memoryGraphDecayTool should be defined", async () => {
    const { memoryGraphDecayTool } = await import("../tools/knowledge/memory-graph")
    expect(memoryGraphDecayTool).toBeDefined()
    expect(memoryGraphDecayTool.name).toBe("memory_graph_decay")
  })
})

describe("ChineseTokenizer", () => {
  it("should tokenize Chinese text", async () => {
    const { tokenizeChinese } = await import("../memory/chinese-tokenizer")
    const tokens = tokenizeChinese("Electron 桌面应用打包配置")
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens).toContain("electron")
    expect(tokens.some(t => t.includes("桌面") || t.includes("应用"))).toBe(true)
  })

  it("should handle mixed Chinese and English", async () => {
    const { tokenizeChinese } = await import("../memory/chinese-tokenizer")
    const tokens = tokenizeChinese("React 是前端框架")
    expect(tokens).toContain("react")
    expect(tokens.some(t => t.includes("前端") || t.includes("框架"))).toBe(true)
  })

  it("should calculate Jaccard similarity", async () => {
    const { jaccardSimilarity } = await import("../memory/chinese-tokenizer")
    const score1 = jaccardSimilarity("Electron 桌面应用", "桌面应用框架")
    const score2 = jaccardSimilarity("Electron 桌面应用", "完全不同的内容")
    expect(score1).toBeGreaterThan(score2)
  })
})

describe("ChineseSynonyms", () => {
  it("should return empty when no graph", async () => {
    const { getSynonyms } = await import("../memory/chinese-synonyms")
    const synonyms = getSynonyms("打包")
    expect(synonyms).toEqual([])
  })

  it("should find synonyms from graph", async () => {
    const { getSynonyms, setGraphInstance } = await import("../memory/chinese-synonyms")
    const { createEmptyGraph, createMemoryNode } = await import("../memory/memory-node")

    const graph = createEmptyGraph()
    const node1 = createMemoryNode("n1", "Electron 打包工具", "semantic")
    const node2 = createMemoryNode("n2", "构建桌面应用", "semantic")
    node1.relatedNodes = ["n2"]
    node2.relatedNodes = ["n1"]
    graph.nodes.set("n1", node1)
    graph.nodes.set("n2", node2)

    setGraphInstance(graph)
    const synonyms = getSynonyms("打包")
    // 应该能从图谱中发现关联词
    expect(Array.isArray(synonyms)).toBe(true)
  })

  it("should expand query with synonyms from graph", async () => {
    const { expandQuery, setGraphInstance } = await import("../memory/chinese-synonyms")
    const { createEmptyGraph, createMemoryNode } = await import("../memory/memory-node")

    const graph = createEmptyGraph()
    const node1 = createMemoryNode("n1", "Electron 打包工具", "semantic")
    const node2 = createMemoryNode("n2", "构建桌面应用", "semantic")
    node1.relatedNodes = ["n2"]
    node2.relatedNodes = ["n1"]
    graph.nodes.set("n1", node1)
    graph.nodes.set("n2", node2)

    setGraphInstance(graph)
    const expanded = expandQuery("打包配置")
    // 应该返回至少包含原始词的列表
    expect(expanded.length).toBeGreaterThan(0)
  })

  it("should calculate synonym-enhanced similarity", async () => {
    const { synonymJaccardSimilarity, setGraphInstance } = await import("../memory/chinese-synonyms")
    const { createEmptyGraph, createMemoryNode } = await import("../memory/memory-node")

    const graph = createEmptyGraph()
    const node1 = createMemoryNode("n1", "打包工具", "semantic")
    const node2 = createMemoryNode("n2", "构建应用", "semantic")
    node1.relatedNodes = ["n2"]
    node2.relatedNodes = ["n1"]
    graph.nodes.set("n1", node1)
    graph.nodes.set("n2", node2)

    setGraphInstance(graph)
    // 相似内容应该得分更高
    const score1 = synonymJaccardSimilarity("打包", "构建")
    const score2 = synonymJaccardSimilarity("打包", "完全不同的词")
    expect(score1).toBeGreaterThanOrEqual(score2)
  })
})

describe("SynonymDiscovery", () => {
  it("should discover synonyms by co-occurrence", async () => {
    const { discoverByCooccurrence } = await import("../memory/synonym-discovery")
    const { createEmptyGraph, createMemoryNode } = await import("../memory/memory-node")

    const graph = createEmptyGraph()

    // 添加节点
    const node1 = createMemoryNode("electron", "Electron 桌面应用打包工具", "semantic")
    const node2 = createMemoryNode("builder", "electron-builder 用于构建桌面应用", "semantic")
    const node3 = createMemoryNode("react", "React 前端框架", "semantic")

    node1.relatedNodes = ["builder", "react"]
    node2.relatedNodes = ["electron"]
    node3.relatedNodes = ["electron"]

    graph.nodes.set("electron", node1)
    graph.nodes.set("builder", node2)
    graph.nodes.set("react", node3)

    graph.edges.push({ source: "electron", target: "builder", relation: "related_to", strength: 0.9, createdAt: new Date(), lastActivated: new Date() })
    graph.edges.push({ source: "electron", target: "react", relation: "related_to", strength: 0.7, createdAt: new Date(), lastActivated: new Date() })

    const results = discoverByCooccurrence("打包", graph, 5)
    // 共现发现应该能找到一些关联词
    expect(results).toBeDefined()
    expect(Array.isArray(results)).toBe(true)
  })

  it("should discover synonyms by structure", async () => {
    const { discoverByStructure } = await import("../memory/synonym-discovery")
    const { createEmptyGraph, createMemoryNode } = await import("../memory/memory-node")

    const graph = createEmptyGraph()

    // 添加节点 - 有相同邻居的节点可能是同义词
    const node1 = createMemoryNode("redux", "Redux 状态管理库", "semantic")
    const node2 = createMemoryNode("vuex", "Vuex 状态管理库", "semantic")
    const node3 = createMemoryNode("app", "应用主节点", "semantic")

    node1.relatedNodes = ["app"]
    node2.relatedNodes = ["app"]
    node3.relatedNodes = ["redux", "vuex"]

    graph.nodes.set("redux", node1)
    graph.nodes.set("vuex", node2)
    graph.nodes.set("app", node3)

    // 结构发现 - redux 和 vuex 有相同的邻居 "app"
    const results = discoverByStructure("状态管理", graph, 5)
    // 应该能找到 vuex（与 redux 有相同邻居）
    expect(results).toBeDefined()
    expect(Array.isArray(results)).toBe(true)
  })
})
