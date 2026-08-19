/**
 * 向量嵌入工具 — 支持中文模型
 * 用于动态记忆图谱的语义搜索
 */

import type { MemoryNode } from "./memory-node"
import { saveEmbedding, getAllEmbeddings } from "./dynamic-memory-store"
import { logError } from "../system/logger"
import { tokenizeChinese, jaccardSimilarity, fuzzySimilarity } from "./chinese-tokenizer"
import { expandQuery, synonymJaccardSimilarity } from "./chinese-synonyms"
import { configureTransformersEnv, EMBEDDING_MODEL, EMBEDDING_DTYPE } from "./transformers-env"

type ExtractPipeline = (texts: string | string[], options?: { pooling?: string; normalize?: boolean }) => Promise<{ data: Float32Array }>

/** 嵌入模型管理器（单例） */
class EmbeddingManager {
  private extract: ExtractPipeline | null = null
  private modelLoading = false
  private modelReady = false
  private modelName: string
  private isChinese: boolean

  constructor(modelName?: string) {
    // 优先使用中文模型（transformers.js ONNX 转换仓库，支持本地/在线两种加载）
    this.modelName = modelName || EMBEDDING_MODEL
    this.isChinese = true
  }

  /** 懒加载模型 */
  async ensureModel(): Promise<boolean> {
    if (this.modelReady) return true
    if (this.modelLoading) return false
    this.modelLoading = true
    try {
      const mod = await import("@huggingface/transformers")
      await configureTransformersEnv()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- 动态导入的类型不完整，集中豁免
      this.extract = await mod.pipeline("feature-extraction", this.modelName, { dtype: EMBEDDING_DTYPE }) as ExtractPipeline
      this.modelReady = true
      console.log(`[DynamicMemory] Embedding model '${this.modelName}' loaded`)
    } catch (err) {
      // 如果中文模型加载失败，回退到英文模型
      console.warn(`[DynamicMemory] Model '${this.modelName}' not available, trying fallback...`)
      try {
        const mod = await import("@huggingface/transformers")
        await configureTransformersEnv()
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- 动态导入的类型不完整，集中豁免
        this.extract = await mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: EMBEDDING_DTYPE }) as ExtractPipeline
        this.modelReady = true
        this.isChinese = false
        console.log(`[DynamicMemory] Fallback model 'Xenova/all-MiniLM-L6-v2' loaded`)
      } catch {
        console.warn(`[DynamicMemory] No embedding model available`)
      }
    } finally {
      this.modelLoading = false
    }
    return this.modelReady
  }

  /** 生成文本嵌入 */
  async embed(text: string): Promise<number[] | null> {
    if (!await this.ensureModel()) return null
    if (!this.extract) return null

    try {
      // 中文文本需要预处理
      const processedText = this.isChinese
        ? tokenizeChinese(text).join(" ")
        : text
      const result = await this.extract(processedText.slice(0, 512), { pooling: "mean", normalize: true })
      return Array.from(result.data)
    } catch {
      return null
    }
  }

  /** 批量生成嵌入 */
  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    const results: (number[] | null)[] = []
    for (const text of texts) {
      results.push(await this.embed(text))
    }
    return results
  }

  /** 计算余弦相似度 */
  static cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
  }
}

/** 全局单例 */
let embeddingManager: EmbeddingManager | null = null

function getEmbeddingManager(): EmbeddingManager {
  if (!embeddingManager) {
    embeddingManager = new EmbeddingManager()
  }
  return embeddingManager
}

/** 为节点生成并保存嵌入 */
export async function generateAndSaveEmbedding(node: MemoryNode): Promise<boolean> {
  const manager = getEmbeddingManager()
  const embedding = await manager.embed(node.content)
  if (!embedding) return false

  try {
    await saveEmbedding(node.id, embedding)
    return true
  } catch (err) {
    logError("[DynamicMemory] Failed to save embedding", err)
    return false
  }
}

/**
 * 混合相似度搜索（结合向量 + 关键词 + 同义词）
 * 这是最准确的搜索方式
 */
export async function hybridSearch(
  query: string,
  nodes: Map<string, MemoryNode>,
  limit: number = 10
): Promise<Array<{ nodeId: string; score: number; breakdown: { vector: number; keyword: number; synonym: number } }>> {
  const manager = getEmbeddingManager()

  // 1. 扩展查询词（添加同义词）
  const expandedTerms = expandQuery(query)
  const expandedQuery = expandedTerms.join(" ")

  // 2. 向量搜索（如果模型可用）
  const vectorScores = new Map<string, number>()
  const queryEmbedding = await manager.embed(expandedQuery)
  if (queryEmbedding) {
    try {
      const allEmbeddings = await getAllEmbeddings()
      for (const { nodeId, embedding } of allEmbeddings) {
        const score = EmbeddingManager.cosineSimilarity(queryEmbedding, embedding)
        if (score > 0.2) {
          vectorScores.set(nodeId, score)
        }
      }
    } catch { /* 静默 */ }
  }

  // 3. 关键词 + 同义词搜索
  const keywordScores = new Map<string, number>()
  const synonymScores = new Map<string, number>()

  for (const [nodeId, node] of nodes) {
    // 关键词匹配
    const kwScore = jaccardSimilarity(query, node.content)
    if (kwScore > 0.1) {
      keywordScores.set(nodeId, kwScore)
    }

    // 同义词匹配
    const synScore = synonymJaccardSimilarity(query, node.content)
    if (synScore > 0.1) {
      synonymScores.set(nodeId, synScore)
    }

    // 模糊匹配（处理拼写错误）
    const fuzzyScore = fuzzySimilarity(query, node.content.slice(0, 20))
    if (fuzzyScore > 0.6) {
      synonymScores.set(nodeId, Math.max(synonymScores.get(nodeId) || 0, fuzzyScore * 0.5))
    }
  }

  // 4. 融合分数（加权平均）
  const allNodeIds = new Set([
    ...vectorScores.keys(),
    ...keywordScores.keys(),
    ...synonymScores.keys(),
  ])

  const results: Array<{ nodeId: string; score: number; breakdown: { vector: number; keyword: number; synonym: number } }> = []

  for (const nodeId of allNodeIds) {
    const vector = vectorScores.get(nodeId) || 0
    const keyword = keywordScores.get(nodeId) || 0
    const synonym = synonymScores.get(nodeId) || 0

    // 加权融合：向量 40% + 关键词 30% + 同义词 30%
    const score = vector * 0.4 + keyword * 0.3 + synonym * 0.3

    if (score > 0.1) {
      results.push({
        nodeId,
        score,
        breakdown: { vector, keyword, synonym },
      })
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

/**
 * 纯关键词搜索（快速，无需向量模型）
 */
export function keywordSearch(
  query: string,
  nodes: Map<string, MemoryNode>,
  limit: number = 10
): Array<{ nodeId: string; score: number }> {
  const expandedTerms = expandQuery(query)
  const results: Array<{ nodeId: string; score: number }> = []

  for (const [nodeId, node] of nodes) {
    let maxScore = 0

    for (const term of expandedTerms) {
      // 精确匹配
      if (node.content.toLowerCase().includes(term.toLowerCase())) {
        maxScore = Math.max(maxScore, 1.0)
        continue
      }

      // 关键词匹配
      const kwScore = jaccardSimilarity(term, node.content)
      maxScore = Math.max(maxScore, kwScore)

      // 同义词匹配
      const synScore = synonymJaccardSimilarity(term, node.content)
      maxScore = Math.max(maxScore, synScore)
    }

    if (maxScore > 0.2) {
      results.push({ nodeId, score: maxScore })
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** 获取嵌入模型状态 */
export function getEmbeddingStatus(): { available: boolean; modelReady: boolean; model: string } {
  const manager = getEmbeddingManager()
  return {
    available: manager["modelReady"],
    modelReady: manager["modelReady"],
    model: manager["modelName"],
  }
}
