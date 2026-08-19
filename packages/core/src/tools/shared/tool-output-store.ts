/**
 * 工具输出管理器 — 参考 OpenCode tool-output-store.ts
 * 统一的大输出管理：
 * - 头尾截断（bounded preview）
 * - 磁盘持久化（超限输出落盘，内存仅保留 preview）
 * - LRU 容量限制 + 7 天 TTL 自动清理
 */
import * as fs from "fs"
import * as path from "path"

const MAX_OUTPUT_SIZE = 100_000
const MAX_LINES = 2000
const DEFAULT_CAPACITY = 1000
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 超过该体积的输出将尝试落盘 */
const PERSIST_THRESHOLD = 50_000

export interface StoredToolOutput {
  id: string
  toolName: string
  content: string
  truncated: boolean
  originalSize: number
  lineCount: number
  /** 完整输出是否落盘（content 仅为 preview） */
  persisted?: boolean
  /** 落盘文件路径 */
  filePath?: string
  storedAt: number
}

export interface ToolOutputStoreOptions {
  maxOutputSize?: number
  maxLines?: number
  /** 内存中保留的最大条目数（LRU 逐出） */
  capacity?: number
  /** TTL 毫秒，超时自动清理 */
  ttlMs?: number
  /** 持久化目录，提供后大输出自动落盘 */
  persistDir?: string
}

export class ToolOutputStore {
  private outputs = new Map<string, StoredToolOutput>()
  private accessOrder: string[] = []
  private options: {
    maxOutputSize: number
    maxLines: number
    capacity: number
    ttlMs: number
    persistDir?: string
  }

  constructor(options: ToolOutputStoreOptions = {}) {
    this.options = {
      maxOutputSize: options.maxOutputSize ?? MAX_OUTPUT_SIZE,
      maxLines: options.maxLines ?? MAX_LINES,
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      persistDir: options.persistDir,
    }
  }

  async store(id: string, toolName: string, output: string): Promise<StoredToolOutput> {
    const originalSize = output.length
    const lines = output.split("\n")
    const lineCount = lines.length
    let truncated = false
    let content = output
    let persisted: boolean | undefined
    let filePath: string | undefined

    // 大输出落盘：仅保留 preview 在内存
    if (originalSize > PERSIST_THRESHOLD && this.options.persistDir) {
      const persistedPath = await this.persist(id, output)
      if (persistedPath) {
        filePath = persistedPath
        persisted = true
        content = `[Output persisted to: ${persistedPath}]\n\n${output.slice(0, this.options.maxOutputSize)}`
        truncated = true
      }
    }

    if (originalSize > this.options.maxOutputSize) {
      const halfBytes = Math.floor(this.options.maxOutputSize / 2)
      content = output.slice(0, halfBytes) +
        "\n\n... [truncated: output too large] ...\n\n" +
        output.slice(-halfBytes)
      truncated = true
    }

    if (lineCount > this.options.maxLines) {
      const halfLines = Math.floor(this.options.maxLines / 2)
      content = lines.slice(0, halfLines).join("\n") +
        `\n\n... [truncated: ${lineCount - this.options.maxLines} lines omitted] ...\n\n` +
        lines.slice(-halfLines).join("\n")
      truncated = true
    }

    const stored: StoredToolOutput = {
      id,
      toolName,
      content,
      truncated,
      originalSize,
      lineCount,
      persisted,
      filePath,
      storedAt: Date.now(),
    }
    this.outputs.set(id, stored)
    this.touch(id)
    this.evictIfNeeded()
    return stored
  }

  get(id: string): StoredToolOutput | undefined {
    const stored = this.outputs.get(id)
    if (stored) this.touch(id)
    return stored
  }

  /** 读取完整输出（落盘时从文件读取） */
  async getFull(id: string): Promise<string | undefined> {
    const stored = this.outputs.get(id)
    if (!stored) return undefined
    this.touch(id)
    if (stored.persisted && stored.filePath) {
      try {
        return fs.readFileSync(stored.filePath, "utf-8")
      } catch {
        return stored.content
      }
    }
    return stored.content
  }

  clear(): void {
    this.outputs.clear()
    this.accessOrder = []
  }

  /** 清理过期条目 + 可选清理孤儿落盘文件 */
  cleanup(): number {
    const now = Date.now()
    const expired: string[] = []
    for (const [id, stored] of this.outputs) {
      if (now - stored.storedAt > this.options.ttlMs) {
        expired.push(id)
      }
    }
    for (const id of expired) this.remove(id)
    return expired.length
  }

  getStats(): { size: number; capacity: number } {
    return { size: this.outputs.size, capacity: this.options.capacity }
  }

  /** 静态工具：落盘 + 返回带 preview 的引用文本（供 ContextManager 等复用） */
  static persistOutput(workspace: string, toolCallId: string, output: string, previewChars = 2000): string {
    if (output.length <= 30000) return output
    try {
      const dir = path.join(workspace, ".task_outputs", "tool-results")
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `${toolCallId}.txt`)
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, output, "utf-8")
      }
      return `<persisted-output>\nFull: ${filePath}\nPreview:\n${output.slice(0, previewChars)}\n</persisted-output>`
    } catch {
      return output
    }
  }

  private persist(id: string, output: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      try {
        const dir = this.options.persistDir!
        fs.mkdirSync(dir, { recursive: true })
        const filePath = path.join(dir, `${id}.txt`)
        fs.writeFileSync(filePath, output, "utf-8")
        resolve(filePath)
      } catch {
        resolve(undefined)
      }
    })
  }

  private touch(id: string): void {
    const idx = this.accessOrder.indexOf(id)
    if (idx >= 0) this.accessOrder.splice(idx, 1)
    this.accessOrder.push(id)
  }

  private evictIfNeeded(): void {
    while (this.outputs.size > this.options.capacity) {
      const lru = this.accessOrder.shift()
      if (!lru) break
      this.remove(lru)
    }
  }

  private remove(id: string): void {
    const stored = this.outputs.get(id)
    this.outputs.delete(id)
    const idx = this.accessOrder.indexOf(id)
    if (idx >= 0) this.accessOrder.splice(idx, 1)
    // 落盘文件同步删除，避免孤儿文件
    if (stored?.persisted && stored.filePath) {
      try {
        fs.unlinkSync(stored.filePath)
      } catch {
        // 忽略删除失败
      }
    }
  }
}
