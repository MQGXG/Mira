/**
 * 动态同义词发现（优化版）
 * 共现 + 结构 + 嵌入（使用缓存）
 */

import type { MemoryNode, MemoryGraph } from "./memory-node"
import { tokenizeChinese } from "./chinese-tokenizer"
import { getEmbeddingCache } from "./embedding-cache"

/** 同义词候选 */
export interface SynonymCandidate {
  term: string
  score: number
  source: "cooccurrence" | "structural" | "embedding"
}

/** 搜索范围配置 */
export interface SearchScope {
  /** 只搜索最近 N 天创建的节点 */
  recentDays?: number
  /** 只搜索强度 >= minStrength 的节点 */
  minStrength?: number
  /** 最大搜索节点数 */
  maxNodes?: number
}

/** 默认搜索范围 */
const DEFAULT_SCOPE: SearchScope = {
  recentDays: 30,
  minStrength: 0.1,
  maxNodes: 500,
}

/**
 * 过滤节点（按搜索范围）
 */
function filterNodes(nodes: MemoryNode[], scope: SearchScope): MemoryNode[] {
  let filtered = Array.from(nodes)

  // 按强度过滤
  if (scope.minStrength !== undefined) {
    filtered = filtered.filter(n => n.strength >= scope.minStrength!)
  }

  // 按时间过滤
  if (scope.recentDays !== undefined) {
    const cutoff = Date.now() - scope.recentDays * 24 * 60 * 60 * 1000
    filtered = filtered.filter(n => n.createdAt.getTime() >= cutoff)
  }

  // 限制数量
  if (scope.maxNodes !== undefined && filtered.length > scope.maxNodes) {
    // 按强度排序，取前 N 个
    filtered = filtered
      .sort((a, b) => b.strength - a.strength)
      .slice(0, scope.maxNodes)
  }

  return filtered
}

/**
 * 从图谱共现关系发现同义词（优化版）
 */
export function discoverByCooccurrence(
  term: string,
  graph: MemoryGraph,
  limit: number = 10,
  scope: SearchScope = DEFAULT_SCOPE
): SynonymCandidate[] {
  const candidates: SynonymCandidate[] = []
  const termLower = term.toLowerCase()

  // 1. 找到包含该词的节点（使用范围过滤）
  const allNodes = Array.from(graph.nodes.values())
  const matchingNodes = filterNodes(allNodes, scope).filter(node =>
    node.content.toLowerCase().includes(termLower)
  )

  if (matchingNodes.length === 0) return []

  // 2. 收集这些节点的所有关联词
  const cooccurringTerms = new Map<string, { count: number; strength: number }>()

  for (const node of matchingNodes) {
    for (const relatedId of node.relatedNodes) {
      const relatedNode = graph.nodes.get(relatedId)
      if (!relatedNode) continue

      const tokens = tokenizeChinese(relatedNode.content)
      for (const token of tokens) {
        if (token === termLower) continue
        const existing = cooccurringTerms.get(token) || { count: 0, strength: 0 }
        existing.count++
        existing.strength += node.associationStrengths.get(relatedId) || 0.5
        cooccurringTerms.set(token, existing)
      }
    }

    const contentTokens = tokenizeChinese(node.content)
    for (const token of contentTokens) {
      if (token === termLower) continue
      const existing = cooccurringTerms.get(token) || { count: 0, strength: 0 }
      existing.count++
      existing.strength += node.strength
      cooccurringTerms.set(token, existing)
    }
  }

  // 3. 排序并返回
  for (const [term, { count, strength }] of cooccurringTerms) {
    const score = (count / matchingNodes.length) * 0.5 + (strength / count) * 0.5
    if (score > 0.2) {
      candidates.push({ term, score, source: "cooccurrence" })
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * 从图谱结构发现同义词（优化版）
 */
export function discoverByStructure(
  term: string,
  graph: MemoryGraph,
  limit: number = 10,
  scope: SearchScope = DEFAULT_SCOPE
): SynonymCandidate[] {
  const candidates: SynonymCandidate[] = []
  const termLower = term.toLowerCase()

  const allNodes = Array.from(graph.nodes.values())
  const filteredNodes = filterNodes(allNodes, scope)
  const matchingNodes = filteredNodes.filter(node =>
    node.content.toLowerCase().includes(termLower)
  )

  if (matchingNodes.length === 0) return []

  const neighborSets = matchingNodes.map(node => new Set(node.relatedNodes))
  const termScores = new Map<string, number>()

  for (const node of filteredNodes) {
    if (node.content.toLowerCase().includes(termLower)) continue

    const nodeNeighbors = new Set(node.relatedNodes)

    let intersection = 0
    for (const neighborSet of neighborSets) {
      for (const n of nodeNeighbors) {
        if (neighborSet.has(n)) intersection++
      }
    }

    const union = nodeNeighbors.size + matchingNodes.reduce((sum, mn) => sum + mn.relatedNodes.length, 0) - intersection
    if (union === 0) continue

    const similarity = intersection / union
    if (similarity > 0.3) {
      const tokens = tokenizeChinese(node.content)
      for (const token of tokens) {
        if (token === termLower) continue
        const existing = termScores.get(token) || 0
        termScores.set(token, Math.max(existing, similarity))
      }
    }
  }

  for (const [term, score] of termScores) {
    candidates.push({ term, score, source: "structural" })
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * 用嵌入模型发现同义词（使用缓存）
 */
export async function discoverByEmbedding(
  term: string,
  graph: MemoryGraph,
  limit: number = 10,
  threshold: number = 0.6,
  scope: SearchScope = DEFAULT_SCOPE
): Promise<SynonymCandidate[]> {
  const candidates: SynonymCandidate[] = []
  const termLower = term.toLowerCase()

  // 使用缓存获取查询词嵌入
  const cache = getEmbeddingCache()

  // 找到包含该词的节点（使用范围过滤）
  const allNodes = Array.from(graph.nodes.values())
  const matchingNodes = filterNodes(allNodes, scope).filter(node =>
    node.content.toLowerCase().includes(termLower)
  )

  if (matchingNodes.length === 0) return []

  // 收集候选词
  const candidateTerms = new Set<string>()
  for (const node of matchingNodes) {
    for (const relatedId of node.relatedNodes) {
      const relatedNode = graph.nodes.get(relatedId)
      if (!relatedNode) continue
      const tokens = tokenizeChinese(relatedNode.content)
      for (const token of tokens) {
        if (token !== termLower && token.length >= 2) {
          candidateTerms.add(token)
        }
      }
    }
  }

  if (candidateTerms.size === 0) return []

  // 使用缓存批量获取嵌入
  const items = Array.from(candidateTerms).map(term => ({
    nodeId: term, // 用 term 作为临时 ID
    text: term,
  }))

  const embeddings = await cache.batchGetEmbeddings(items)

  // 获取查询词嵌入
  const queryEmb = await cache.getEmbedding(term, term)
  if (!queryEmb) return []

  // 计算相似度
  for (const [candidateTerm, candidateEmb] of embeddings) {
    const score = cache["cosineSimilarity"](queryEmb, candidateEmb)
    if (score >= threshold) {
      candidates.push({ term: candidateTerm, score, source: "embedding" })
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * 发现术语的同义词（综合方法）
 */
export async function discoverSynonyms(
  term: string,
  graph: MemoryGraph,
  limit: number = 10,
  scope: SearchScope = DEFAULT_SCOPE
): Promise<SynonymCandidate[]> {
  // 1. 共现发现（快速）
  const cooccurrenceResults = discoverByCooccurrence(term, graph, limit, scope)

  // 2. 结构发现（快速）
  const structuralResults = discoverByStructure(term, graph, limit, scope)

  // 3. 嵌入发现（使用缓存）
  const embeddingResults = await discoverByEmbedding(term, graph, limit, 0.6, scope)

  // 4. 合并结果（加权）
  const allCandidates = new Map<string, SynonymCandidate>()

  for (const candidate of cooccurrenceResults) {
    allCandidates.set(candidate.term, { ...candidate, score: candidate.score * 0.3 })
  }

  for (const candidate of structuralResults) {
    const existing = allCandidates.get(candidate.term)
    if (existing) {
      existing.score += candidate.score * 0.3
    } else {
      allCandidates.set(candidate.term, { ...candidate, score: candidate.score * 0.3 })
    }
  }

  for (const candidate of embeddingResults) {
    const existing = allCandidates.get(candidate.term)
    if (existing) {
      existing.score += candidate.score * 0.4
      existing.source = "embedding"
    } else {
      allCandidates.set(candidate.term, { ...candidate, score: candidate.score * 0.4 })
    }
  }

  return Array.from(allCandidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * 从节点内容中提取关键词
 */
export function extractKeywords(content: string): string[] {
  const tokens = tokenizeChinese(content)
  const freq = new Map<string, number>()
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1)
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term)
}
