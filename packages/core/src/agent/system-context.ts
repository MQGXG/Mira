/**
 * 增量 System Context — 参考 OpenCode 的 SystemContext
 * 只更新变化的 context 部分，减少重建开销
 */

export interface ContextSource {
  key: string
  content: string
  hash: string
  lastUpdated: number
}

export interface ContextSnapshot {
  sources: Map<string, ContextSnapshotEntry>
  baseline: string
  lastReconciled: number
}

interface ContextSnapshotEntry {
  key: string
  content: string
  hash: string
  lastUpdated: number
}

// 简单哈希函数
function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return hash.toString(36)
}

export class SystemContextManager {
  private sources: Map<string, ContextSource> = new Map()
  private baseline: string = ""
  private lastReconciled: number = 0
  private workspace: string

  constructor(workspace: string) {
    this.workspace = workspace
  }

  /**
   * 注册或更新一个 context source
   */
  updateSource(key: string, content: string): boolean {
    const hash = simpleHash(content)
    const existing = this.sources.get(key)

    if (existing && existing.hash === hash) {
      return false // 没变化
    }

    this.sources.set(key, {
      key,
      content,
      hash,
      lastUpdated: Date.now(),
    })

    return true // 有变化
  }

  /**
   * 移除一个 context source
   */
  removeSource(key: string): boolean {
    return this.sources.delete(key)
  }

  /**
   * 获取所有 sources 的内容
   */
  getAllContent(): string {
    const parts: string[] = []
    for (const source of this.sources.values()) {
      parts.push(source.content)
    }
    return parts.join("\n\n")
  }

  /**
   * 获取变化的 sources（增量更新）
   */
  getChangedSources(since: number): ContextSource[] {
    const changed: ContextSource[] = []
    for (const source of this.sources.values()) {
      if (source.lastUpdated > since) {
        changed.push(source)
      }
    }
    return changed
  }

  /**
   * 调和：比较当前 sources 与快照，返回变化摘要
   */
  reconcile(previousSnapshot?: ContextSnapshot): {
    added: string[]
    updated: string[]
    removed: string[]
    baselineChanged: boolean
  } {
    const added: string[] = []
    const updated: string[] = []
    const removed: string[] = []

    if (previousSnapshot) {
      // 检查新增和更新
      for (const [key, source] of this.sources) {
        const prev = previousSnapshot.sources.get(key)
        if (!prev) {
          added.push(key)
        } else if (prev.hash !== source.hash) {
          updated.push(key)
        }
      }

      // 检查删除
      for (const key of previousSnapshot.sources.keys()) {
        if (!this.sources.has(key)) {
          removed.push(key)
        }
      }
    } else {
      // 首次调和，所有都是新增
      for (const key of this.sources.keys()) {
        added.push(key)
      }
    }

    // 检查 baseline 变化
    const newBaseline = this.buildBaseline()
    const baselineChanged = newBaseline !== this.baseline
    this.baseline = newBaseline
    this.lastReconciled = Date.now()

    return { added, updated, removed, baselineChanged }
  }

  /**
   * 构建 baseline（核心不变的部分）
   */
  private buildBaseline(): string {
    const parts: string[] = []

    // 环境信息
    parts.push(`Workspace: ${this.workspace}`)
    parts.push(`Time: ${new Date().toISOString()}`)

    return parts.join("\n")
  }

  /**
   * 获取当前快照
   */
  getSnapshot(): ContextSnapshot {
    return {
      sources: new Map(this.sources),
      baseline: this.baseline,
      lastReconciled: this.lastReconciled,
    }
  }

  /**
   * 从快照恢复
   */
  restoreFromSnapshot(snapshot: ContextSnapshot): void {
    this.sources = new Map(snapshot.sources)
    this.baseline = snapshot.baseline
    this.lastReconciled = snapshot.lastReconciled
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    sourceCount: number
    totalContentLength: number
    lastReconciled: number
  } {
    let totalLength = 0
    for (const source of this.sources.values()) {
      totalLength += source.content.length
    }

    return {
      sourceCount: this.sources.size,
      totalContentLength: totalLength,
      lastReconciled: this.lastReconciled,
    }
  }
}

export function createSystemContextManager(workspace: string): SystemContextManager {
  return new SystemContextManager(workspace)
}
