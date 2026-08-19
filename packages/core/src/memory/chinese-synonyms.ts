/**
 * 中文同义词系统（纯动态版）
 * 完全依赖图谱动态发现 + 嵌入模型
 */

import { discoverSynonyms, discoverByCooccurrence, discoverByStructure, type SynonymCandidate } from "./synonym-discovery"
import type { MemoryGraph } from "./memory-node"

/** 图谱实例 */
let graphInstance: MemoryGraph | null = null

/** 设置图谱实例 */
export function setGraphInstance(graph: MemoryGraph): void {
  graphInstance = graph
}

/** 获取同义词（异步，使用嵌入模型） */
export async function getSynonymsAsync(word: string): Promise<string[]> {
  if (!graphInstance) return []

  const discovered = await discoverSynonyms(word, graphInstance, 10)
  return discovered.map(d => d.term)
}

/** 获取同义词（同步，只用共现和结构，不使用嵌入） */
export function getSynonyms(word: string): string[] {
  if (!graphInstance) return []

  // 同步版本只用共现和结构发现
  const cooccurrence = discoverByCooccurrence(word, graphInstance, 5)
  const structural = discoverByStructure(word, graphInstance, 5)

  const terms = new Set<string>()
  for (const c of cooccurrence) terms.add(c.term)
  for (const s of structural) terms.add(s.term)

  return Array.from(terms)
}

/** 判断两个词是否为同义词 */
export function areSynonyms(a: string, b: string): boolean {
  const lowerA = a.toLowerCase()
  const lowerB = b.toLowerCase()

  if (lowerA === lowerB) return true

  const synonyms = getSynonyms(lowerA)
  return synonyms.some(s => s.toLowerCase() === lowerB)
}

/** 扩展查询词（异步，使用嵌入模型） */
export async function expandQueryAsync(query: string): Promise<string[]> {
  const cleaned = query
    .replace(/[\u3000-\u303F\uFF00-\uFFEF！？。，、；：""''【】（）《》]/g, " ")
    .trim()

  const tokens = cleaned
    .toLowerCase()
    .split(/[\s,;，；]+/)
    .filter(t => t.length >= 2)

  const expanded = new Set<string>()

  for (const token of tokens) {
    expanded.add(token)

    // 异步获取同义词（使用嵌入模型）
    const synonyms = await getSynonymsAsync(token)
    for (const syn of synonyms) {
      expanded.add(syn.toLowerCase())
    }

    // 对于中文，尝试 2-gram 查找
    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length >= 4) {
      for (let i = 0; i <= token.length - 2; i++) {
        const bigram = token.slice(i, i + 2)
        const bigramSynonyms = await getSynonymsAsync(bigram)
        for (const syn of bigramSynonyms) {
          expanded.add(syn.toLowerCase())
        }
      }
    }
  }

  return Array.from(expanded)
}

/** 扩展查询词（同步，不使用嵌入） */
export function expandQuery(query: string): string[] {
  const cleaned = query
    .replace(/[\u3000-\u303F\uFF00-\uFFEF！？。，、；：""''【】（）《》]/g, " ")
    .trim()

  const tokens = cleaned
    .toLowerCase()
    .split(/[\s,;，；]+/)
    .filter(t => t.length >= 2)

  const expanded = new Set<string>()

  for (const token of tokens) {
    expanded.add(token)

    const synonyms = getSynonyms(token)
    for (const syn of synonyms) {
      expanded.add(syn.toLowerCase())
    }

    if (/^[\u4e00-\u9fff]+$/.test(token) && token.length >= 4) {
      for (let i = 0; i <= token.length - 2; i++) {
        const bigram = token.slice(i, i + 2)
        const bigramSynonyms = getSynonyms(bigram)
        for (const syn of bigramSynonyms) {
          expanded.add(syn.toLowerCase())
        }
      }
    }
  }

  return Array.from(expanded)
}

/** 同义词增强的 Jaccard 相似度 */
export function synonymJaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/[\s,;，；]+/).filter(t => t.length >= 2))
  const tokensB = new Set(b.toLowerCase().split(/[\s,;，；]+/).filter(t => t.length >= 2))

  if (tokensA.size === 0 && tokensB.size === 0) return 0

  let intersection = 0
  for (const tokenA of tokensA) {
    for (const tokenB of tokensB) {
      if (tokenA === tokenB || areSynonyms(tokenA, tokenB)) {
        intersection++
        break
      }
    }
  }

  const union = tokensA.size + tokensB.size - intersection
  return union > 0 ? intersection / union : 0
}
