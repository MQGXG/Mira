/**
 * 动态记忆图谱管理器
 * 整合记忆节点、强度计算、衰减曲线、激活传播 + SQLite 持久化
 */

import type { MemoryNode, MemoryEdge, MemoryGraph, ActivationResult, MemoryType , DECAY_PROFILES } from "./memory-node"
import { createEmptyGraph, createMemoryNode, createMemoryEdge } from "./memory-node"
import { calculateStrength, updateStrengthAfterAccess, shouldConsolidate } from "./memory-strength"
import { decayStrength, batchDecay } from "./decay-curve"
import { activateMemory, simpleTextRelevance, DEFAULT_ACTIVATION_CONFIG, type ActivationConfig } from "./memory-activation"
import type { DecayConfig } from "./memory-node"
import {
  loadGraph, saveNode, saveNodesBulk, saveEdge, deleteNode,
  saveMetadata, saveCommunities, clearAll,
  searchNodesFTS,
} from "./dynamic-memory-store"
import { generateAndSaveEmbedding, hybridSearch, keywordSearch } from "./embedding"
import { setGraphInstance } from "./chinese-synonyms"
import { getEmbeddingCache } from "./embedding-cache"
import { logError } from "../system/logger"

/** 动态记忆管理器 */
export class DynamicMemoryManager {
  private graph: MemoryGraph
  private activationConfig: ActivationConfig
  private initialized = false
  private loadPromise: Promise<void> | null = null

  constructor(config?: Partial<ActivationConfig>) {
    this.graph = createEmptyGraph()
    this.activationConfig = { ...DEFAULT_ACTIVATION_CONFIG, ...config }
  }

  /** 异步初始化：从 SQLite 加载图谱 */
  async init(): Promise<void> {
    if (this.initialized) return
    if (this.loadPromise) return this.loadPromise

    this.loadPromise = (async () => {
      try {
        this.graph = await loadGraph()
        // 设置图谱实例用于动态同义词发现
        setGraphInstance(this.graph)
        // 预热嵌入缓存（异步，不阻塞初始化）
        const cache = getEmbeddingCache()
        cache.loadFromDB().then(() => cache.warmup(this.graph)).catch(() => {})
        this.initialized = true
      } catch (err) {
        console.error("[DynamicMemoryManager] Failed to load graph:", err)
        this.graph = createEmptyGraph()
        setGraphInstance(this.graph)
        this.initialized = true
      }
    })()

    return this.loadPromise
  }

  /** 确保已初始化（public：工具/外部调用前保证已从 SQLite 加载图谱） */
  async ensureInit(): Promise<void> {
    if (!this.initialized) await this.init()
  }

  /** 加载图谱数据（覆盖） */
  loadGraph(data: MemoryGraph): void {
    this.graph = data
  }

  /** 获取图谱 */
  getGraph(): MemoryGraph {
    return this.graph
  }

  /** 添加记忆节点 */
  async addNode(
    id: string,
    content: string,
    type: MemoryType = "semantic",
    decayProfile: keyof typeof DECAY_PROFILES = "documentation"
  ): Promise<MemoryNode> {
    await this.ensureInit()
    const node = createMemoryNode(id, content, type, decayProfile)
    this.graph.nodes.set(id, node)
    this.updateMetadata()
    // 持久化
    try {
      await saveNode(node)
      // 异步生成向量嵌入（不阻塞）
      generateAndSaveEmbedding(node).catch(() => {})
    } catch (err) { logError("[DynamicMemoryManager] saveNode failed", err) }
    return node
  }

  /** 添加记忆边 */
  async addEdge(
    source: string,
    target: string,
    relation: string,
    strength: number = 0.5
  ): Promise<MemoryEdge> {
    await this.ensureInit()
    const edge = createMemoryEdge(source, target, relation, strength)
    this.graph.edges.push(edge)

    // 更新节点的关联列表
    const sourceNode = this.graph.nodes.get(source)
    const targetNode = this.graph.nodes.get(target)

    if (sourceNode && !sourceNode.relatedNodes.includes(target)) {
      sourceNode.relatedNodes.push(target)
      sourceNode.associationStrengths.set(target, strength)
    }

    if (targetNode && !targetNode.relatedNodes.includes(source)) {
      targetNode.relatedNodes.push(source)
      targetNode.associationStrengths.set(source, strength)
    }

    this.updateMetadata()

    // 持久化
    try {
      await saveEdge(edge)
      if (sourceNode) await saveNode(sourceNode)
      if (targetNode) await saveNode(targetNode)
    } catch (err) { logError("[DynamicMemoryManager] saveEdge failed", err) }

    return edge
  }

  /** 激活记忆（查询） */
  async activate(
    query: string,
    queryRelevance?: (query: string, node: MemoryNode) => number
  ): Promise<ActivationResult> {
    await this.ensureInit()
    const relevanceFn = queryRelevance || simpleTextRelevance
    const result = await activateMemory(query, this.graph, relevanceFn, this.activationConfig)

    // 更新激活节点的强度（P3：批量事务写，替代逐个 saveNode，减少首 token 前落盘次数）
    const updatedNodes: MemoryNode[] = []
    for (const node of result.nodes) {
      const updated = updateStrengthAfterAccess(node)
      this.graph.nodes.set(node.id, updated)
      updatedNodes.push(updated)
    }
    try { saveNodesBulk(updatedNodes) } catch { /* 静默 */ }

    return result
  }

  /** 获取激活结果的格式化文本 */
  formatActivationResult(result: ActivationResult): string {
    if (result.nodes.length === 0) {
      return "未找到相关记忆。"
    }

    const lines: string[] = []

    if (result.spontaneousRecall) {
      lines.push("[记忆激活] 触发了突然想起机制")
    }

    lines.push(`激活了 ${result.nodes.length} 个相关记忆：\n`)

    for (const node of result.nodes.slice(0, 10)) {
      const strength = calculateStrength(node)
      const strengthBar = "█".repeat(Math.round(strength * 10))
      lines.push(`  ${node.id} [${strengthBar}] 强度: ${strength.toFixed(2)}`)
      lines.push(`    ${node.content.slice(0, 100)}...`)
      lines.push("")
    }

    if (result.paths.length > 0) {
      lines.push("激活路径：")
      for (const path of result.paths.slice(0, 5)) {
        lines.push(`  ${path.from} → ${path.to} (${path.strength.toFixed(2)})`)
      }
    }

    return lines.join("\n")
  }

  /** 执行遗忘衰减 */
  async performDecay(): Promise<number> {
    await this.ensureInit()
    const nodes = Array.from(this.graph.nodes.values())
    const now = new Date()
    let forgottenCount = 0

    for (const node of nodes) {
      const hoursSinceAccess = (now.getTime() - node.lastAccessed.getTime()) / (1000 * 60 * 60)
      const newStrength = decayStrength(
        node.strength,
        hoursSinceAccess,
        node.decayConfig.decayRate
      )

      if (newStrength < node.decayConfig.minStrength) {
        node.strength = node.decayConfig.minStrength
        node.metadata.forgotten = true
        node.metadata.forgottenAt = now.toISOString()
        forgottenCount++
      } else {
        node.strength = newStrength
      }

      try { await saveNode(node) } catch { /* 静默 */ }
    }

    return forgottenCount
  }

  /** 执行记忆固化 */
  async performConsolidation(): Promise<number> {
    await this.ensureInit()
    const nodes = Array.from(this.graph.nodes.values())
    let consolidatedCount = 0

    for (const node of nodes) {
      if (shouldConsolidate(node)) {
        node.importance = Math.min(1.0, node.importance + 0.1)
        node.metadata.consolidated = true
        node.metadata.consolidatedAt = new Date().toISOString()
        consolidatedCount++
        try { await saveNode(node) } catch { /* 静默 */ }
      }
    }

    return consolidatedCount
  }

  /** 删除节点 */
  async removeNode(nodeId: string): Promise<boolean> {
    await this.ensureInit()
    const node = this.graph.nodes.get(nodeId)
    if (!node) return false

    // 从所有关联节点中移除引用
    for (const relatedId of node.relatedNodes) {
      const relatedNode = this.graph.nodes.get(relatedId)
      if (relatedNode) {
        relatedNode.relatedNodes = relatedNode.relatedNodes.filter(id => id !== nodeId)
        relatedNode.associationStrengths.delete(nodeId)
      }
    }

    this.graph.nodes.delete(nodeId)
    this.graph.edges = this.graph.edges.filter(e => e.source !== nodeId && e.target !== nodeId)
    this.updateMetadata()

    try { await deleteNode(nodeId) } catch { /* 静默 */ }
    return true
  }

  /** 获取社区信息 */
  getCommunities(): Map<string, MemoryNode[]> {
    const communities = new Map<string, MemoryNode[]>()

    for (const node of this.graph.nodes.values()) {
      if (node.communityId) {
        const nodes = communities.get(node.communityId) || []
        nodes.push(node)
        communities.set(node.communityId, nodes)
      }
    }

    return communities
  }

  /** 获取社区统计 */
  getCommunityStats(): Array<{ id: string; name: string; count: number; avgStrength: number }> {
    const communities = this.getCommunities()
    const stats: Array<{ id: string; name: string; count: number; avgStrength: number }> = []

    for (const [id, nodes] of communities) {
      const avgStrength = nodes.reduce((sum, n) => sum + n.strength, 0) / nodes.length
      stats.push({
        id,
        name: this.getCommunityName(id),
        count: nodes.length,
        avgStrength,
      })
    }

    return stats.sort((a, b) => b.count - a.count)
  }

  /** 获取社区名称（基于最连接的节点） */
  private getCommunityName(communityId: string): string {
    const nodes = this.graph.nodes.get(communityId)?.relatedNodes || []
    if (nodes.length > 0) {
      return this.graph.nodes.get(nodes[0])?.id || communityId
    }
    return communityId
  }

  /** 更新图谱元数据 */
  private updateMetadata(): void {
    this.graph.metadata = {
      totalNodes: this.graph.nodes.size,
      totalEdges: this.graph.edges.length,
      totalCommunities: this.getCommunities().size,
      lastUpdated: new Date(),
    }
  }

  /** 导出图谱数据 */
  export(): Record<string, unknown> {
    return {
      nodes: Object.fromEntries(this.graph.nodes),
      edges: [...this.graph.edges],
      communities: Object.fromEntries(this.graph.communities),
      metadata: { ...this.graph.metadata },
    }
  }

  /** 从 JSON 导入图谱 */
  importFromJSON(json: string): void {
    const data = JSON.parse(json)

    // 恢复节点
    this.graph.nodes = new Map()
    if (data.nodes && typeof data.nodes === "object") {
      for (const [id, node] of Object.entries(data.nodes as Record<string, MemoryNode>)) {
        this.graph.nodes.set(id, node)
      }
    }

    // 恢复边
    this.graph.edges = data.edges || []

    // 恢复社区
    this.graph.communities = new Map()
    if (data.communities && typeof data.communities === "object") {
      for (const [id, nodes] of Object.entries(data.communities as Record<string, string[]>)) {
        this.graph.communities.set(id, nodes)
      }
    }

    this.graph.metadata = data.metadata || {
      totalNodes: 0,
      totalEdges: 0,
      totalCommunities: 0,
      lastUpdated: new Date(),
    }
  }

  /** 导出为 JSON */
  toJSON(): string {
    return JSON.stringify(this.export(), null, 2)
  }

  /** 语义搜索（结合 FTS5 + 向量 + 关键词 + 同义词） */
  async semanticSearch(
    query: string,
    limit: number = 10
  ): Promise<Array<{ node: MemoryNode; score: number; source: "hybrid" | "fts" | "keyword" }>> {
    await this.ensureInit()

    // 1. 混合搜索（最准确）
    const hybridResults = await hybridSearch(query, this.graph.nodes, limit)

    // 2. FTS5 搜索
    const ftsResults = await searchNodesFTS(query, limit)

    // 3. 关键词搜索（快速）
    const keywordResults = keywordSearch(query, this.graph.nodes, limit)

    // 4. 融合结果
    const nodeScores = new Map<string, { score: number; source: "hybrid" | "fts" | "keyword" }>()

    // 混合搜索结果（权重最高）
    for (const { nodeId, score } of hybridResults) {
      nodeScores.set(nodeId, { score: score * 1.5, source: "hybrid" })
    }

    // FTS 结果
    for (let i = 0; i < ftsResults.length; i++) {
      const nodeId = ftsResults[i]
      const score = 1 / (i + 1)
      const existing = nodeScores.get(nodeId)
      if (existing) {
        existing.score += score
      } else {
        nodeScores.set(nodeId, { score, source: "fts" })
      }
    }

    // 关键词结果
    for (const { nodeId, score } of keywordResults) {
      const existing = nodeScores.get(nodeId)
      if (existing) {
        existing.score += score * 0.5
      } else {
        nodeScores.set(nodeId, { score: score * 0.5, source: "keyword" })
      }
    }

    // 5. 排序并返回
    const results: Array<{ node: MemoryNode; score: number; source: "hybrid" | "fts" | "keyword" }> = []
    for (const [nodeId, { score, source }] of nodeScores) {
      const node = this.graph.nodes.get(nodeId)
      if (node) {
        results.push({ node, score, source })
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /** 清空所有数据（含数据库） */
  async clear(): Promise<void> {
    this.graph = createEmptyGraph()
    try { await clearAll() } catch { /* 静默 */ }
  }
}

/** 创建动态记忆管理器的便捷函数 */
export function createDynamicMemory(config?: Partial<ActivationConfig>): DynamicMemoryManager {
  return new DynamicMemoryManager(config)
}
