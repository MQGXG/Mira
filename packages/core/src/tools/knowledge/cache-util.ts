/**
 * 简单 TTL 缓存 — 内存级，自动过期
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

export class TTLCache<T = string> {
  private store = new Map<string, CacheEntry<T>>()
  private ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.data
  }

  set(key: string, data: T): void {
    this.store.set(key, { data, expiresAt: Date.now() + this.ttlMs })
  }

  /** 生成缓存 key */
  static makeKey(prefix: string, ...parts: string[]): string {
    return `${prefix}:${parts.join(":")}`
  }
}
