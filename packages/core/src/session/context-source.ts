/**
 * System Context Sources — 对标 opencode Context Epochs 的增量式系统上下文管理
 *
 * 将系统提示拆分为独立 Source，每个 Source 可独立加载、变化追踪、持久化快照。
 * 当某个 Source 变化时，只生成该 Source 的更新文本，而非替换整个 system prompt。
 */

import * as fs from "fs"
import * as path from "path"
import { DEFAULT_SYSTEM } from "../agent/constants"
import { getPlatformPaths } from "../config/paths"

/** 将 workspace 路径转为安全的目录名（用于 userData 下 per-workspace 隔离） */
function workspaceSlug(workspace: string): string {
  return workspace.replace(/[\\/:*?"<>|]/g, "_") || "root"
}

// ── 类型定义 ────────────────────────────────────────────

/** Source 唯一标识 */
export type SourceKey = "base" | "env" | "memory" | "code" | "goal" | "mode" | "knowledge"

/** Source 变化指纹 — 用于判断是否需要重新生成 */
export interface SourceFingerprint {
  /** 内容哈希或版本号 */
  hash: string
  /** 上次更新时间 */
  updatedAt: number
}

/** Source 生成时的上下文参数 */
export interface SourceContext {
  sessionID: string
  workspace: string
  mode?: string
  goalDescription?: string
  currentFile?: string
  customSystemPrompt?: string
  /** 上一次的 fingerprint，可用于判断增量更新 */
  previousFingerprint?: SourceFingerprint
}

/** Context Source 接口 — 每个系统提示组件实现此接口 */
export interface ContextSource {
  /** Source 标识 */
  readonly key: SourceKey
  /** 优先级（数字越小越靠前） */
  readonly priority: number
  /** 是否启用 */
  enabled: boolean

  /** 生成当前内容 */
  generate(ctx: SourceContext): Promise<string> | string

  /** 计算变化指纹 — 用于增量更新判断 */
  fingerprint(ctx: SourceContext): SourceFingerprint

  /** 可选：持久化快照到磁盘 */
  saveSnapshot?(key: SourceKey, content: string, fingerprint: SourceFingerprint): void

  /** 可选：从快照恢复（加速启动） */
  loadSnapshot?(key: SourceKey): { content: string; fingerprint: SourceFingerprint } | null
}

// ── SourceManager ────────────────────────────────────────

export class SourceManager {
  private sources: Map<SourceKey, ContextSource> = new Map()
  private fingerprints: Map<SourceKey, SourceFingerprint> = new Map()
  private snapshotDir: string

  constructor(workspace: string) {
    // 快照存到 userData（而非 workspace），避免污染项目仓库；per-workspace 隔离
    this.snapshotDir = path.join(getPlatformPaths().userData, "context-snapshots", workspaceSlug(workspace))
  }

  /** 注册 Source */
  register(source: ContextSource): void {
    this.sources.set(source.key, source)
  }

  /** 批量注册 */
  registerAll(sources: ContextSource[]): void {
    for (const source of sources) {
      this.register(source)
    }
  }

  /** 启用/禁用 Source */
  setEnabled(key: SourceKey, enabled: boolean): void {
    const source = this.sources.get(key)
    if (source) source.enabled = enabled
  }

  /** 生成完整系统提示（增量模式） */
  async build(ctx: SourceContext): Promise<string> {
    const sorted = [...this.sources.values()]
      .filter(s => s.enabled)
      .sort((a, b) => a.priority - b.priority)

    const parts: string[] = []
    for (const source of sorted) {
      const prev = this.fingerprints.get(source.key)
      const current = source.fingerprint(ctx)

      // 增量：仅当 fingerprint 变化时重新生成
      if (prev && prev.hash === current.hash && source.loadSnapshot) {
        const cached = source.loadSnapshot(source.key)
        if (cached) {
          parts.push(cached.content)
          continue
        }
      }

      const content = await source.generate(ctx)
      this.fingerprints.set(source.key, current)
      source.saveSnapshot?.(source.key, content, current)
      parts.push(content)
    }

    return parts.join("\n\n")
  }

  /** 获取 Source 列表（用于 UI 展示） */
  list(): Array<{ key: SourceKey; priority: number; enabled: boolean; hash: string }> {
    return [...this.sources.values()].map(s => ({
      key: s.key,
      priority: s.priority,
      enabled: s.enabled,
      hash: this.fingerprints.get(s.key)?.hash || "",
    }))
  }

  /** 获取当前 fingerprint 状态 */
  getFingerprints(): Map<SourceKey, SourceFingerprint> {
    return new Map(this.fingerprints)
  }

  /**
   * 分离式系统提示构建（对齐 dsh renderPrompt + renderContextSnapshot）
   *
   * 稳定 Source（priority < 90）→ system；动态 Source（priority >= 90，如 memory）
   * → 独立 context 块。动态内容变化不再污染稳定前缀，缓存命中更高。
   */
  async buildSeparated(ctx: SourceContext): Promise<{ system: string; context: string }> {
    const sorted = [...this.sources.values()]
      .filter((s) => s.enabled)
      .sort((a, b) => a.priority - b.priority)

    const systemParts: string[] = []
    const contextParts: string[] = []
    for (const source of sorted) {
      const content = await source.generate(ctx)
      if (!content) continue
      if (source.priority >= 90) contextParts.push(content)
      else systemParts.push(content)
    }

    const context = contextParts.length > 0
      ? `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${contextParts.join("\n\n")}`
      : ""
    return { system: systemParts.join("\n\n"), context }
  }

  /** 重置所有 fingerprint（强制全量重建） */
  resetFingerprints(): void {
    this.fingerprints.clear()
  }
}

// ── BaseSource 实现 ──────────────────────────────────────

export class BaseSource implements ContextSource {
  readonly key: SourceKey = "base"
  readonly priority = 10
  enabled = true

  private customPrompt: string | null = null

  setCustomPrompt(prompt: string): void {
    this.customPrompt = prompt
  }

  generate(_ctx: SourceContext): string {
    return this.customPrompt || _ctx.customSystemPrompt || DEFAULT_SYSTEM
  }

  fingerprint(_ctx: SourceContext): SourceFingerprint {
    // 基础提示通常是静态的，使用固定 hash
    return { hash: this.customPrompt ? `base-custom-${this.customPrompt.length}` : "base-default-v1", updatedAt: Date.now() }
  }
}

// ── EnvSource 实现 ───────────────────────────────────────

export class EnvSource implements ContextSource {
  readonly key: SourceKey = "env"
  readonly priority = 20
  enabled = true

  generate(ctx: SourceContext): string {
    const parts: string[] = [
      "<env>",
      `  Working directory: ${ctx.workspace || "unknown"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      "</env>",
    ]
    return parts.join("\n")
  }

  fingerprint(_ctx: SourceContext): SourceFingerprint {
    return { hash: `env-${new Date().toDateString()}-v1`, updatedAt: Date.now() }
  }
}

// ── ModeSource 实现 ──────────────────────────────────────

export class ModeSource implements ContextSource {
  readonly key: SourceKey = "mode"
  readonly priority = 30
  enabled = true

  private modeSuffix = ""

  setModeSuffix(suffix: string): void {
    this.modeSuffix = suffix
  }

  generate(ctx: SourceContext): string {
    if (!ctx.mode) return ""
    if (this.modeSuffix) {
      return `[MODE: ${ctx.mode}]\n${this.modeSuffix}`
    }
    return `[MODE: ${ctx.mode}]`
  }

  fingerprint(ctx: SourceContext): SourceFingerprint {
    return { hash: `mode-${ctx.mode || "default"}-${this.modeSuffix.length}`, updatedAt: Date.now() }
  }
}

// ── MemorySource 实现 ────────────────────────────────────

export class MemorySource implements ContextSource {
  readonly key: SourceKey = "memory"
  readonly priority = 100
  enabled = true

  private memoryContent = ""

  setMemoryContent(content: string): void {
    this.memoryContent = content
  }

  generate(_ctx: SourceContext): string {
    return this.memoryContent
  }

  fingerprint(_ctx: SourceContext): SourceFingerprint {
    // 基于内容长度 + 内容前 100 字符生成 hash
    const preview = this.memoryContent.slice(0, 100)
    return { hash: `mem-${this.memoryContent.length}-${preview}`, updatedAt: Date.now() }
  }
}

// ── CodeSource 实现 ──────────────────────────────────────

export class CodeSource implements ContextSource {
  readonly key: SourceKey = "code"
  readonly priority = 50
  enabled = true

  private codeSuffix = ""
  private workspace = ""

  setCodeSuffix(suffix: string): void {
    this.codeSuffix = suffix
  }

  generate(_ctx: SourceContext): string {
    return this.codeSuffix
  }

  fingerprint(ctx: SourceContext): SourceFingerprint {
    this.workspace = ctx.workspace
    return { hash: `code-${ctx.currentFile || "none"}-${this.codeSuffix.length}`, updatedAt: Date.now() }
  }

  /** 持久化快照（存到 userData，不污染项目仓库） */
  saveSnapshot(key: SourceKey, content: string, fingerprint: SourceFingerprint): void {
    try {
      const dir = path.join(getPlatformPaths().userData, "context-snapshots", workspaceSlug(this.workspace || process.cwd()))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, `${key}.json`),
        JSON.stringify({ content, fingerprint }, null, 2),
        "utf-8",
      )
    } catch { /* 静默 */ }
  }

  /** 从快照恢复 */
  loadSnapshot(key: SourceKey): { content: string; fingerprint: SourceFingerprint } | null {
    try {
      const snapshotPath = path.join(getPlatformPaths().userData, "context-snapshots", workspaceSlug(this.workspace || process.cwd()), `${key}.json`)
      if (!fs.existsSync(snapshotPath)) return null
      return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as { content: string; fingerprint: SourceFingerprint }
    } catch {
      return null
    }
  }
}

// ── GoalSource 实现 ──────────────────────────────────────

export class GoalSource implements ContextSource {
  readonly key: SourceKey = "goal"
  readonly priority = 60
  enabled = true

  private goalContent = ""

  setGoalContent(content: string): void {
    this.goalContent = content
  }

  generate(_ctx: SourceContext): string {
    return this.goalContent
  }

  fingerprint(_ctx: SourceContext): SourceFingerprint {
    return { hash: `goal-${this.goalContent.length}-${this.goalContent.slice(0, 80)}`, updatedAt: Date.now() }
  }
}

// ── KnowledgeSource 实现 ─────────────────────────────────

export class KnowledgeSource implements ContextSource {
  readonly key: SourceKey = "knowledge"
  readonly priority = 45
  enabled = true

  private knowledgeContent = ""

  setKnowledgeContent(content: string): void {
    this.knowledgeContent = content
  }

  generate(_ctx: SourceContext): string {
    if (!this.knowledgeContent) return ""
    return `[Project Knowledge]\n${this.knowledgeContent}`
  }

  fingerprint(_ctx: SourceContext): SourceFingerprint {
    return { hash: `knowledge-${this.knowledgeContent.length}-${this.knowledgeContent.slice(0, 80)}`, updatedAt: Date.now() }
  }
}
