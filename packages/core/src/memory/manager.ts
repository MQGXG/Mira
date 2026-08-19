import type { MemoryProvider } from "./types"
import type { BuiltinMemoryProvider } from "./builtin-provider"
import type { FileMemoryProvider } from "./file-memory-provider"
import type { FTSMemoryProvider } from "./fts-memory-provider"
import { logError } from "../system/logger"

const PROVIDER_PRIORITY: Record<string, number> = {
  checkpoint: 0,
  builtin: 1,
  "fts-memory": 2,
  file_memory: 3,
  vector: 4,
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** 查询归一化：去空白/小写/截断，用于 prefetch 缓存 key */
function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 200).toLowerCase()
}

interface NotesEntry {
  user: string
  assistant: string
}

export class MemoryManager {
  private providers: MemoryProvider[] = []
  private turnCount = 0
  private dreamAutoTriggerInterval = 10
  /** session 级去重（LRU 语义，最多保留 1000 条，超限时裁剪旧条目） */
  private seenFacts = new Map<string, number>()
  private seenFactsMaxSize = 1000
  private notesBuffer: NotesEntry[] = []
  private flushBatchSize = 3
  /**
   * P1 优化：prefetch 结果 TTL 缓存。
   * 同 session 内相同（归一化）查询在 5s 内复用结果，避免 ReAct 多步/重试时
   * 重复执行 provider prefetch + FTS5 不可用时的 LIKE 全表扫描（首 token 提速）。
   */
  private prefetchCache = new Map<string, { content: string; at: number }>()
  private prefetchCacheTTL = 5000

  addProvider(provider: MemoryProvider): void {
    this.providers.push(provider)
  }

  /** 获取 FTS Provider（用于联动操作） */
  getFTSProvider(): FTSMemoryProvider | null {
    return (this.providers.find(p => p.name === "fts-memory") as FTSMemoryProvider) || null
  }

  /** 获取 Builtin Provider（session 级记忆） */
  getBuiltinProvider(): BuiltinMemoryProvider | null {
    return (this.providers.find(p => p.name === "builtin") as BuiltinMemoryProvider) || null
  }

  /** 获取 File Provider（项目级记忆） */
  getFileProvider(): FileMemoryProvider | null {
    return (this.providers.find(p => p.name === "file_memory") as FileMemoryProvider) || null
  }

  /** 记忆提升：session 级 → 项目级 */
  async promoteMemories(sessionID: string): Promise<void> {
    await this.flushWriter(sessionID)
    const builtin = this.getBuiltinProvider()
    const fileMem = this.getFileProvider()
    if (!builtin || !fileMem) return

    const frequentFacts = builtin.getFrequentFacts()
    if (frequentFacts.length > 0) {
      fileMem.acceptPromotedFacts(frequentFacts)
    }
  }

  /** 从消息历史中提取最近用户消息，选择相关记忆并注入 */
  async selectMemories(messages: any[], sessionID: string, tokenBudget = 1500): Promise<string> {
    // 从最近的 assistant 消息之后找用户消息
    let latestUser = ""
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === "user") {
        latestUser = typeof msg.content === "string" ? msg.content : ""
        break
      }
    }
    if (!latestUser.trim()) return ""

    const memoryContent = await this.prefetch(latestUser, sessionID, tokenBudget)
    return memoryContent
  }

  async initialize(sessionID: string, workspace: string): Promise<void> {
    await Promise.all(
      this.providers.map(async (p) => {
        try { await p.initialize(sessionID, workspace) } catch (e) {
          logError(`[MemoryManager] Provider "${p.name}" 初始化失败`, e)
        }
      }),
    )
  }

  buildSystemPrompt(): string {
    return this.providers
      .map((p) => {
        try { return p.buildSystemPrompt() } catch (e) {
          logError(`[MemoryManager] Provider "${p.name}" buildSystemPrompt 失败`, e)
          return ""
        }
      })
      .filter(Boolean)
      .join("\n\n")
  }

  /**
   * 预算注入 — 按 token 预算控制 prefetch 结果
   * 支持跨 session 搜索（FTS 提供）
   */
  async prefetch(query: string, sessionID: string, tokenBudget = 2000): Promise<string> {
    // P1：TTL 缓存命中时直接复用，跳过全部 provider 检索与跨会话扫描
    const cacheKey = `${sessionID}:${normalizeQuery(query)}`
    const now = Date.now()
    const cached = this.prefetchCache.get(cacheKey)
    if (cached && now - cached.at < this.prefetchCacheTTL) {
      return cached.content
    }

    const results = await Promise.all(
      this.providers.map(async (p) => {
        try {
          const content = await p.prefetch(query, sessionID)
          return { name: p.name, content, priority: PROVIDER_PRIORITY[p.name] ?? 99 }
        } catch (e) {
          logError(`[MemoryManager] Provider "${p.name}" prefetch 失败`, e)
          return null
        }
      }),
    )

    // P2：本地记忆已足够时跳过跨会话 LIKE 全表扫描（FTS5 不可用时该扫描最耗时）
    const localTokens = results.reduce(
      (sum, r) => sum + (r ? estimateTokens(r.content) : 0),
      0,
    )
    if (localTokens < tokenBudget * 0.5) {
      const ftsProvider = this.getFTSProvider()
      if (ftsProvider) {
        try {
          const crossSessionContent = await ftsProvider.prefetchMemory(query)
          if (crossSessionContent) {
            results.push({ name: "fts-memory", content: crossSessionContent, priority: PROVIDER_PRIORITY["fts-memory"] })
          }
        } catch { /* 跨 session 搜索失败不阻塞 */ }
      }
    }

    const sorted = results
      .filter((r): r is NonNullable<typeof r> => r !== null && r.content.length > 0)
      .sort((a, b) => a.priority - b.priority)

    const parts: string[] = []
    let usedTokens = 0

    for (const item of sorted) {
      const dedupedContent = this.deduplicateContent(item.content)
      const itemTokens = estimateTokens(dedupedContent)
      if (usedTokens + itemTokens > tokenBudget) {
        const remaining = tokenBudget - usedTokens
        if (remaining > 200) {
          const truncated = dedupedContent.slice(0, remaining * 4)
          parts.push(truncated)
        }
        break
      }
      parts.push(dedupedContent)
      usedTokens += itemTokens
    }

    const content = parts.join("\n\n")
    this.prefetchCache.set(cacheKey, { content, at: now })
    return content
  }

  /** Single-writer: 追加到 notes 缓冲区，批量刷新到 providers */
  async syncTurn(user: string, assistant: string, sessionID: string): Promise<void> {
    this.turnCount++
    // 新记忆写入会使 prefetch 结果过期，清除缓存
    this.prefetchCache.clear()
    this.notesBuffer.push({ user, assistant })

    if (this.notesBuffer.length >= this.flushBatchSize) {
      await this.flushWriter(sessionID)
    }

    // 索引到 FTS 供跨会话搜索（仅用户内容有实质信息时索引，避免噪音）
    const fts = this.getFTSProvider()
    if (fts && user.trim().length > 20) {
      const preview = `[${sessionID.slice(0, 12)}] 用户: ${user.slice(0, 200)}\n回复: ${assistant.slice(0, 300)}`
      fts.indexCheckpoint(preview, sessionID)
    }
  }

  /** 强制刷新缓冲区（shutdown 或手动触发时调用） */
  async flushWriter(sessionID: string): Promise<void> {
    if (this.notesBuffer.length === 0) return

    const batch = [...this.notesBuffer]
    this.notesBuffer = []

    for (const entry of batch) {
      await Promise.all(
        this.providers.map(async (p) => {
          try { await p.syncTurn(entry.user, entry.assistant, sessionID) } catch (e) {
            logError(`[MemoryManager] Provider "${p.name}" flushWriter 失败`, e)
          }
        }),
      )
    }
  }

  shouldAutoDream(): boolean {
    return this.turnCount > 0 && this.turnCount % this.dreamAutoTriggerInterval === 0
  }

  /** 去重：移除跨 provider 的重复内容（LRU 语义，session 维度） */
  private deduplicateContent(content: string): string {
    const lines = content.split("\n").filter(Boolean)
    const unique: string[] = []
    for (const line of lines) {
      const normalized = line.trim().toLowerCase()
      if (!this.seenFacts.has(normalized)) {
        // 超限时裁剪最早的一半
        if (this.seenFacts.size >= this.seenFactsMaxSize) {
          const entries = [...this.seenFacts.entries()]
            .sort((a, b) => a[1] - b[1])
            .slice(0, this.seenFactsMaxSize / 2)
          this.seenFacts = new Map(entries)
        }
        this.seenFacts.set(normalized, Date.now())
        unique.push(line)
      }
    }
    return unique.join("\n")
  }

  /** 清理去重缓存（session 切换时调用） */
  clearDedupCache(): void {
    this.seenFacts.clear()
    this.prefetchCache.clear()
  }

  async shutdown(): Promise<void> {
    await this.flushWriter("")
    await Promise.all(
      this.providers.map(async (p) => {
        try { await p.shutdown() } catch (e) {
          logError(`[MemoryManager] Provider "${p.name}" shutdown 失败`, e)
        }
      }),
    )
  }
}
