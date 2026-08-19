/**
 * 向量记忆 Provider — 使用 Transformers.js 本地 ONNX 推理
 * 替代 OpenAI Embeddings API，零外部依赖，完全本地运行
 */

import { join } from "path"
import fs from "fs"
import type { MemoryProvider } from "./types"
import { getPlatformPaths } from "../config/paths"
import { createHash } from "crypto"
import { configureTransformersEnv, EMBEDDING_MODEL, EMBEDDING_DTYPE } from "./transformers-env"

interface MemoryDocument {
  id: string
  text: string
  embedding: number[]
  timestamp: string
  sessionID: string
}

interface VectorStore {
  documents: MemoryDocument[]
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

function chunkText(text: string, maxLen = 200): string[] {
  const chunks: string[] = []
  const sentences = text.split(/[。！？.!?\n]+/).filter(Boolean)
  let current = ""
  for (const s of sentences) {
    if ((current + s).length > maxLen && current) {
      chunks.push(current.trim())
      current = s
    } else {
      current += s
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

type ExtractPipeline = (texts: string | string[], options?: { pooling?: string; normalize?: boolean }) => Promise<{ data: Float32Array }>

export class VectorMemoryProvider implements MemoryProvider {
  name = "vector"
  private extract: ExtractPipeline | null = null
  private modelLoading = false
  private modelReady = false
  private store: VectorStore = { documents: [] }
  private storePath = ""
  private sessionID = ""
  private modelName: string

  constructor(config?: { modelName?: string }) {
    // 统一使用中文嵌入模型（transformers.js ONNX 仓库，支持本地/在线加载）
    this.modelName = config?.modelName || EMBEDDING_MODEL
  }

  async initialize(sessionID: string, _workspace: string): Promise<void> {
    this.sessionID = sessionID
    const dir = join(getPlatformPaths().userData, "vector-memory")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.storePath = join(dir, `${sessionID}.json`)
    this.loadStore()
    // 模型懒加载：不阻塞初始化，首次使用时再加载
  }

  buildSystemPrompt(): string {
    const count = this.store.documents.length
    return count > 0 && this.modelReady
      ? `[Vector Memory: ${count} semantic memory entries available. I can recall past decisions and context from previous turns.]`
      : ""
  }

  /** 懒加载模型，失败时静默跳过 */
  private async ensureModel(): Promise<boolean> {
    if (this.modelReady) return true
    if (this.modelLoading) return false
    this.modelLoading = true
    try {
      const mod = await import("@huggingface/transformers")
      await configureTransformersEnv()
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- 动态导入的类型不完整，集中豁免
      this.extract = await mod.pipeline("feature-extraction", this.modelName, { dtype: EMBEDDING_DTYPE }) as ExtractPipeline
      this.modelReady = true
      console.log(`[VectorMemory] Model '${this.modelName}' loaded`)
    } catch (err) {
      console.warn(`[VectorMemory] Model '${this.modelName}' not available: ${err instanceof Error ? err.message : String(err)}. Vector memory disabled.`)
    } finally {
      this.modelLoading = false
    }
    return this.modelReady
  }

  async prefetch(query: string, _sessionID: string): Promise<string> {
    if (this.store.documents.length === 0) return ""
    if (!await this.ensureModel()) return ""

    try {
      const queryEmbedding = await this.getEmbedding(query)
      if (!queryEmbedding || queryEmbedding.length === 0) return ""

      const scored = this.store.documents
        .map((doc) => ({ doc, score: cosineSimilarity(queryEmbedding, doc.embedding) }))
        .filter((s) => s.score > 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)

      if (scored.length === 0) return ""

      return (
        `<memory-context>\n` +
        `[System note: The following is semantically recalled memory, ` +
        `NOT new user input. Treat as authoritative reference data.]\n\n` +
        scored.map((s) => `- [${s.score.toFixed(2)}] ${s.doc.text}`).join("\n") +
        `\n</memory-context>`
      )
    } catch {
      return ""
    }
  }

  async syncTurn(user: string, assistant: string, _sessionID: string): Promise<void> {
    if (!await this.ensureModel()) return

    const combined = `${user}\n${assistant}`
    const chunks = chunkText(combined)

    for (const chunk of chunks) {
      if (chunk.length < 20) continue
      const embedding = await this.getEmbedding(chunk)
      if (!embedding || embedding.length === 0) continue

      const id = createHash("md5").update(chunk).digest("hex")
      if (this.store.documents.some((d) => d.id === id)) continue

      this.store.documents.push({
        id,
        text: chunk.slice(0, 500),
        embedding,
        timestamp: new Date().toISOString(),
        sessionID: this.sessionID,
      })
    }

    if (this.store.documents.length > 500) {
      this.store.documents = this.store.documents.slice(-500)
    }
    this.saveStore()
  }

  async shutdown(): Promise<void> {
    this.saveStore()
  }

  private async getEmbedding(text: string): Promise<number[] | null> {
    if (!this.extract) return null
    try {
      const result = await this.extract(text, { pooling: "mean", normalize: true })
      return Array.from(result.data)
    } catch {
      return null
    }
  }

  private loadStore(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        this.store = JSON.parse(fs.readFileSync(this.storePath, "utf-8"))
      }
    } catch { this.store = { documents: [] } }
  }

  private saveStore(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), "utf-8")
    } catch { /* 静默 */ }
  }
}

