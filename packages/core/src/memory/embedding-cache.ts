/**
 * 嵌入缓存优化器
 * 解决大数据量下的查询性能问题
 */

import type { MemoryNode, MemoryGraph } from "./memory-node"
import { getAllEmbeddings, saveEmbedding } from "./dynamic-memory-store"
import { configureTransformersEnv, EMBEDDING_MODEL, EMBEDDING_DTYPE } from "./transformers-env"

/** 缓存条目 */
interface CacheEntry {
  nodeId: string
  embedding: number[]
  lastAccessed: number
  accessCount: number
}

/** 缓存配置 */
export interface CacheConfig {
  /** 最大缓存条目数 */
  maxEntries: number
  /** 最大内存使用（MB） */
  maxMemoryMB: number
  /** 缓存过期时间（毫秒） */
  ttlMs: number
  /** 预加载节点数（按强度排序） */
  preloadCount: number
}

/** 默认配置 */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxEntries: 5000,
  maxMemoryMB: 100,
  ttlMs: 30 * 60 * 1000, // 30分钟
  preloadCount: 1000,
}

/**
 * LRU 嵌入缓存
 */
export class EmbeddingCache {
  private cache = new Map<string, CacheEntry>()
  private config: CacheConfig
  private totalMemoryBytes = 0
  private embeddingDimension = 0

  constructor(config?: Partial<CacheConfig>) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config }
  }

  /**
   * 获取嵌入（优先从缓存）
   */
  async getEmbedding(nodeId: string, text: string): Promise<number[] | null> {
    // 1. 检查缓存
    const cached = this.cache.get(nodeId)
    if (cached) {
      cached.lastAccessed = Date.now()
      cached.accessCount++
      return cached.embedding
    }

    // 2. 缓存未命中，需要计算
    const embedding = await this.computeEmbedding(text)
    if (!embedding) return null

    // 3. 存入缓存
    this.set(nodeId, embedding)

    return embedding
  }

  /**
   * 批量获取嵌入（优化版）
   * 只计算缺失的嵌入，减少重复计算
   */
  async batchGetEmbeddings(
    items: Array<{ nodeId: string; text: string }>
  ): Promise<Map<string, number[]>> {
    const results = new Map<string, number[]>()
    const toCompute: Array<{ nodeId: string; text: string }> = []

    // 1. 从缓存获取已有的
    for (const item of items) {
      const cached = this.cache.get(item.nodeId)
      if (cached) {
        cached.lastAccessed = Date.now()
        cached.accessCount++
        results.set(item.nodeId, cached.embedding)
      } else {
        toCompute.push(item)
      }
    }

    // 2. 批量计算缺失的
    if (toCompute.length > 0) {
      const pipeline = await this.getPipeline()
      if (pipeline) {
        for (const item of toCompute) {
          try {
            const emb = await pipeline(item.text.slice(0, 512), { pooling: "mean", normalize: true })
            const embedding = Array.from(emb.data as Float32Array)
            this.set(item.nodeId, embedding)
            results.set(item.nodeId, embedding)
          } catch { /* 静默 */ }
        }
      }
    }

    return results
  }

  /**
   * 预热缓存（加载高强度节点）
   */
  async warmup(graph: MemoryGraph): Promise<void> {
    console.log(`[EmbeddingCache] Warming up with top ${this.config.preloadCount} nodes...`)

    // 按强度排序，取前 N 个
    const topNodes = Array.from(graph.nodes.values())
      .sort((a, b) => b.strength - a.strength)
      .slice(0, this.config.preloadCount)

    const items = topNodes.map(node => ({
      nodeId: node.id,
      text: node.content,
    }))

    await this.batchGetEmbeddings(items)
    console.log(`[EmbeddingCache] Warmup complete. Cache size: ${this.cache.size}`)
  }

  /**
   * 从数据库加载缓存
   */
  async loadFromDB(): Promise<void> {
    try {
      const embeddings = await getAllEmbeddings()
      for (const { nodeId, embedding } of embeddings) {
        if (this.cache.size >= this.config.maxEntries) break
        this.set(nodeId, embedding, false) // 不检查限制
      }
      console.log(`[EmbeddingCache] Loaded ${this.cache.size} embeddings from DB`)
    } catch (err) {
      console.warn("[EmbeddingCache] Failed to load from DB:", err)
    }
  }

  /**
   * 保存缓存到数据库
   */
  async saveToDB(): Promise<void> {
    let saved = 0
    for (const [nodeId, entry] of this.cache) {
      try {
        await saveEmbedding(nodeId, entry.embedding)
        saved++
      } catch { /* 静默 */ }
    }
    console.log(`[EmbeddingCache] Saved ${saved} embeddings to DB`)
  }

  /**
   * 向量搜索（从缓存中搜索）
   */
  vectorSearch(
    queryEmbedding: number[],
    limit: number = 10,
    threshold: number = 0.3
  ): Array<{ nodeId: string; score: number }> {
    const results: Array<{ nodeId: string; score: number }> = []

    for (const [nodeId, entry] of this.cache) {
      const score = this.cosineSimilarity(queryEmbedding, entry.embedding)
      if (score >= threshold) {
        results.push({ nodeId, score })
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * 清理过期条目
   */
  cleanup(): number {
    const now = Date.now()
    let removed = 0

    for (const [nodeId, entry] of this.cache) {
      if (now - entry.lastAccessed > this.config.ttlMs) {
        this.totalMemoryBytes -= entry.embedding.length * 8
        this.cache.delete(nodeId)
        removed++
      }
    }

    return removed
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
    size: number
    memoryMB: number
    hitRate: number
    avgAccessCount: number
  } {
    let totalAccess = 0
    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount
    }

    return {
      size: this.cache.size,
      memoryMB: this.totalMemoryBytes / (1024 * 1024),
      hitRate: this.cache.size > 0 ? totalAccess / this.cache.size : 0,
      avgAccessCount: this.cache.size > 0 ? totalAccess / this.cache.size : 0,
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 私有方法
  // ═══════════════════════════════════════════════════════════════

  private set(nodeId: string, embedding: number[], checkLimits = true): void {
    // 检查内存限制
    if (checkLimits) {
      const entrySize = embedding.length * 8 // 8 bytes per number
      if (this.totalMemoryBytes + entrySize > this.config.maxMemoryMB * 1024 * 1024) {
        this.evictOldest()
      }
      if (this.cache.size >= this.config.maxEntries) {
        this.evictOldest()
      }
    }

    this.cache.set(nodeId, {
      nodeId,
      embedding,
      lastAccessed: Date.now(),
      accessCount: 1,
    })
    this.totalMemoryBytes += embedding.length * 8

    if (this.embeddingDimension === 0) {
      this.embeddingDimension = embedding.length
    }
  }

  private evictOldest(): void {
    let oldest: string | null = null
    let oldestTime = Infinity

    for (const [nodeId, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed
        oldest = nodeId
      }
    }

    if (oldest) {
      const entry = this.cache.get(oldest)!
      this.totalMemoryBytes -= entry.embedding.length * 8
      this.cache.delete(oldest)
    }
  }

  private async computeEmbedding(text: string): Promise<number[] | null> {
    const pipeline = await this.getPipeline()
    if (!pipeline) return null

    try {
      const result = await pipeline(text.slice(0, 512), { pooling: "mean", normalize: true })
      return Array.from(result.data as Float32Array)
    } catch {
      return null
    }
  }

  private async getPipeline(): Promise<any> {
    try {
      const mod = await import("@huggingface/transformers")
      await configureTransformersEnv()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- 动态导入的类型不完整，集中豁免
      return await mod.pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: EMBEDDING_DTYPE })
    } catch {
      return null
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
  }
}

/** 全局缓存单例 */
let globalCache: EmbeddingCache | null = null

export function getEmbeddingCache(): EmbeddingCache {
  if (!globalCache) {
    globalCache = new EmbeddingCache()
  }
  return globalCache
}
