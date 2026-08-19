/**
 * Fork Agent 前缀缓存 — 参考 MiMo-Code 的 fork prefix cache
 * Checkpoint writer 共享父 Agent 的系统提示缓存，降低成本
 */

interface CacheEntry {
  key: string
  systemPrompt: string
  tools: string[]
  timestamp: number
  hitCount: number
}

interface CacheStats {
  hits: number
  misses: number
  hitRate: number
}

export class ForkCacheManager {
  private cache: Map<string, CacheEntry> = new Map()
  private maxEntries = 100
  private ttlMs = 3600_000 // 1 小时过期

  /**
   * 存储父 Agent 的系统提示到缓存
   */
  set(systemPrompt: string, tools: string[], sessionId?: string): string {
    const key = this.generateKey(systemPrompt, tools)
    const existing = this.cache.get(key)

    if (existing) {
      existing.hitCount++
      existing.timestamp = Date.now()
      return existing.key
    }

    // 检查容量
    if (this.cache.size >= this.maxEntries) {
      this.evictOldest()
    }

    const entry: CacheEntry = {
      key,
      systemPrompt,
      tools,
      timestamp: Date.now(),
      hitCount: 1,
    }

    this.cache.set(key, entry)
    return key
  }

  /**
   * 获取缓存的系统提示（用于子 Agent）
   */
  get(key: string): { systemPrompt: string; tools: string[] } | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    // 检查过期
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key)
      return null
    }

    entry.hitCount++
    return {
      systemPrompt: entry.systemPrompt,
      tools: entry.tools,
    }
  }

  /**
   * 尝试复用父 Agent 的缓存
   * 如果找到匹配的缓存，返回缓存的 key
   */
  reuseParentCache(parentSystemPrompt: string, parentTools: string[]): string | null {
    const key = this.generateKey(parentSystemPrompt, parentTools)
    const entry = this.cache.get(key)

    if (entry && (Date.now() - entry.timestamp <= this.ttlMs)) {
      entry.hitCount++
      return entry.key
    }

    return null
  }

  /**
   * 清除过期条目
   */
  purge(): number {
    const now = Date.now()
    let purged = 0

    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key)
        purged++
      }
    }

    return purged
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats & { size: number; entries: number } {
    let hits = 0
    const misses = 0

    for (const entry of this.cache.values()) {
      hits += entry.hitCount
    }

    const total = hits + misses
    return {
      hits,
      misses,
      hitRate: total > 0 ? hits / total : 0,
      size: this.cache.size,
      entries: this.cache.size,
    }
  }

  /**
   * 生成缓存 key
   */
  private generateKey(systemPrompt: string, tools: string[]): string {
    // 使用系统提示和工具列表的组合生成 key
    const toolsStr = tools.sort().join(",")
    const promptHash = this.simpleHash(systemPrompt)
    const toolsHash = this.simpleHash(toolsStr)
    return `${promptHash}_${toolsHash}`
  }

  /**
   * 驱逐最旧条目
   */
  private evictOldest(): void {
    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey)
    }
  }

  /**
   * 简单哈希函数
   */
  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < Math.min(str.length, 1000); i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash |= 0
    }
    return hash.toString(36)
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear()
  }
}

// 全局实例
let globalForkCache: ForkCacheManager | null = null

export function getForkCacheManager(): ForkCacheManager {
  if (!globalForkCache) {
    globalForkCache = new ForkCacheManager()
  }
  return globalForkCache
}
