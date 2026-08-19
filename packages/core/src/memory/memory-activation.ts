/**
 * 记忆激活传播算法（优化版）
 * 使用 FTS5 索引 + 邻接表，避免 O(n) 全表扫描
 */

import type { MemoryNode, MemoryEdge, MemoryGraph, ActivationResult } from "./memory-node"
import { calculateStrength, rankScore } from "./memory-strength"
import { searchNodesFTS, buildAdjacencyList } from "./dynamic-memory-store"

/** 激活配置 */
export interface ActivationConfig {
  /** 最大传播深度 */
  maxDepth: number
  /** 激活阈值（低于此值不激活） */
  activationThreshold: number
  /** 突然想起阈值（弱记忆低于此值可通过关联激活） */
  spontaneousRecallThreshold: number
  /** 传播衰减因子（每层传播衰减） */
  propagationDecay: number
  /** 最大激活节点数 */
  maxActivatedNodes: number
}

/** 默认激活配置 */
export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  maxDepth: 3,
  activationThreshold: 0.3,
  spontaneousRecallThreshold: 0.15,
  propagationDecay: 0.7,
  maxActivatedNodes: 20,
}

/** 种子节点（直接匹配） */
interface SeedNode {
  node: MemoryNode
  relevance: number
}

/**
 * 记忆激活传播（优化版）
 * 使用 FTS5 索引查找种子节点，使用邻接表加速传播
 */
export async function activateMemory(
  query: string,
  graph: MemoryGraph,
  queryRelevance: (query: string, node: MemoryNode) => number,
  config: ActivationConfig = DEFAULT_ACTIVATION_CONFIG
): Promise<ActivationResult> {
  const now = new Date()
  const activatedNodes = new Map<string, { node: MemoryNode; strength: number; depth: number }>()
  const paths: Array<{ from: string; to: string; strength: number }> = []
  let spontaneousRecall = false

  // 1. 使用 FTS5 索引快速查找种子节点
  const seeds = await findSeedNodesFast(query, graph, queryRelevance)

  // 2. 激活种子节点
  for (const seed of seeds) {
    activatedNodes.set(seed.node.id, {
      node: seed.node,
      strength: seed.relevance,
      depth: 0,
    })
  }

  // 3. 构建邻接表（一次性 O(e) 构建，后续 O(1) 查询）
  const adjacencyList = await buildAdjacencyList()

  // 4. BFS 传播激活
  let frontier = seeds.map(s => ({ nodeId: s.node.id, depth: 0, strength: s.relevance }))

  while (frontier.length > 0 && activatedNodes.size < config.maxActivatedNodes) {
    const nextFrontier: Array<{ nodeId: string; depth: number; strength: number }> = []

    for (const { nodeId, depth, strength } of frontier) {
      if (depth >= config.maxDepth) continue

      // 使用邻接表 O(1) 获取邻居（而非遍历所有边）
      const neighbors = adjacencyList.get(nodeId) || []

      for (const { neighborId, strength: edgeStrength } of neighbors) {
        const neighbor = graph.nodes.get(neighborId)
        if (!neighbor) continue

        // 计算传播后的激活强度
        const propagatedStrength = strength * config.propagationDecay * edgeStrength

        // 跳过低于阈值的传播
        if (propagatedStrength < config.activationThreshold) continue

        // 检查是否已激活
        const existing = activatedNodes.get(neighborId)
        if (existing) {
          if (propagatedStrength > existing.strength) {
            activatedNodes.set(neighborId, {
              node: neighbor,
              strength: propagatedStrength,
              depth: depth + 1,
            })
            paths.push({ from: nodeId, to: neighborId, strength: propagatedStrength })
          }
          continue
        }

        // 新激活
        activatedNodes.set(neighborId, {
          node: neighbor,
          strength: propagatedStrength,
          depth: depth + 1,
        })
        paths.push({ from: nodeId, to: neighborId, strength: propagatedStrength })

        nextFrontier.push({
          nodeId: neighborId,
          depth: depth + 1,
          strength: propagatedStrength,
        })
      }
    }

    frontier = nextFrontier
  }

  // 5. 突然想起（弱记忆通过强关联重新激活）
  // P3：图谱节点过多时跳过该 O(n) 全量遍历（收益低成本高，避免拖慢首 token）
  const SPONTANEOUS_RECALL_MAX_NODES = 1000
  if (graph.nodes.size <= SPONTANEOUS_RECALL_MAX_NODES) {
    for (const [nodeId, node] of graph.nodes) {
      if (node.strength >= config.spontaneousRecallThreshold || activatedNodes.has(nodeId)) continue

      const neighbors = adjacencyList.get(nodeId) || []
      const strongActivatedNeighbors = neighbors.filter(n => {
        const activated = activatedNodes.get(n.neighborId)
        return activated && activated.strength > 0.5
      })

      if (strongActivatedNeighbors.length > 0) {
        const maxStrength = Math.max(
          ...strongActivatedNeighbors.map(n => activatedNodes.get(n.neighborId)?.strength || 0)
        )
        const spontaneousStrength = maxStrength * 0.3

        if (spontaneousStrength >= config.activationThreshold) {
          activatedNodes.set(nodeId, {
            node,
            strength: spontaneousStrength,
            depth: config.maxDepth,
          })
          spontaneousRecall = true
          paths.push({
            from: strongActivatedNeighbors[0].neighborId,
            to: nodeId,
            strength: spontaneousStrength,
          })
        }
      }
    }
  }

  // 6. 排序并限制结果
  const sortedNodes = Array.from(activatedNodes.values())
    .sort((a, b) => b.strength - a.strength)
    .slice(0, config.maxActivatedNodes)
    .map(item => item.node)

  // 7. 计算整体激活强度
  const activationStrength = sortedNodes.length > 0
    ? sortedNodes.reduce((sum, n) => sum + (activatedNodes.get(n.id)?.strength || 0), 0) / sortedNodes.length
    : 0

  return {
    nodes: sortedNodes,
    paths,
    activationStrength,
    spontaneousRecall,
  }
}

/**
 * 快速查找种子节点（使用 FTS5 索引）
 * 复杂度: O(k * log n) 而非 O(n * m)
 */
async function findSeedNodesFast(
  query: string,
  graph: MemoryGraph,
  queryRelevance: (query: string, node: MemoryNode) => number
): Promise<SeedNode[]> {
  // 1. 先用 FTS5 快速定位候选节点
  const candidateIds = await searchNodesFTS(query, 20)

  // 2. 对候选节点计算精确相关性
  const seeds: SeedNode[] = []
  for (const id of candidateIds) {
    const node = graph.nodes.get(id)
    if (!node) continue
    const relevance = queryRelevance(query, node)
    if (relevance > 0.3) {
      seeds.push({ node, relevance })
    }
  }

  // 3. 如果 FTS 没找到，回退到全表扫描（但只在小图谱时）
  if (seeds.length === 0 && graph.nodes.size < 500) {
    for (const node of graph.nodes.values()) {
      const relevance = queryRelevance(query, node)
      if (relevance > 0.3) {
        seeds.push({ node, relevance })
      }
    }
  }

  return seeds.sort((a, b) => b.relevance - a.relevance).slice(0, 5)
}

/** 文本相关性计算（简单的关键词匹配） */
export function simpleTextRelevance(query: string, node: MemoryNode): number {
  const queryLower = query.toLowerCase()
  const contentLower = node.content.toLowerCase()

  // 精确匹配
  if (contentLower.includes(queryLower)) {
    return 1.0
  }

  // 关键词匹配
  const queryWords = queryLower.split(/\s+/)
  const contentWords = contentLower.split(/\s+/)

  let matchCount = 0
  for (const word of queryWords) {
    if (word.length < 2) continue
    if (contentWords.some(cw => cw.includes(word))) {
      matchCount++
    }
  }

  const matchRatio = matchCount / queryWords.length
  return matchRatio * 0.8
}

/** 语义相关性计算（基于 TF-IDF 的简化版本） */
export function semanticRelevance(query: string, node: MemoryNode): number {
  const queryTerms = extractTerms(query)
  const contentTerms = extractTerms(node.content)

  // 计算余弦相似度
  const allTerms = new Set([...queryTerms.keys(), ...contentTerms.keys()])
  let dotProduct = 0
  let queryNorm = 0
  let contentNorm = 0

  for (const term of allTerms) {
    const qVal = queryTerms.get(term) || 0
    const cVal = contentTerms.get(term) || 0
    dotProduct += qVal * cVal
    queryNorm += qVal * qVal
    contentNorm += cVal * cVal
  }

  if (queryNorm === 0 || contentNorm === 0) return 0

  return dotProduct / (Math.sqrt(queryNorm) * Math.sqrt(contentNorm))
}

/** 提取文本术语（TF 权重） */
function extractTerms(text: string): Map<string, number> {
  const terms = new Map<string, number>()
  const words = text.toLowerCase().split(/[\s\W]+/).filter(w => w.length > 2)

  for (const word of words) {
    terms.set(word, (terms.get(word) || 0) + 1)
  }

  // TF 归一化
  const maxTf = Math.max(...terms.values(), 1)
  for (const [term, tf] of terms) {
    terms.set(term, tf / maxTf)
  }

  return terms
}
