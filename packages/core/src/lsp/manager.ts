/**
 * LSP 管理器 — 语言服务器生命周期编排
 * 职责分离：server-defs（服务器定义）、dependency（依赖管理）、indexing（索引进度）
 * 本模块仅负责生命周期组装与高层查询 API
 */

import { LSPClient, type LSPLocationResult, type LSPHoverResult, type LSPDocumentSymbol } from "./client"
import { detectLanguageServer, getLanguageId, type LanguageServerDef } from "./server-defs"
import { lspDependencyResolver } from "./dependency"
import { IndexingTracker } from "./indexing"
import { diffDiagnostics, type DiagnosticCheckResult } from "./diagnostic-check"
import * as path from "path"
import * as fs from "fs"
import { pathToFileURL, fileURLToPath } from "url"

export interface LSPLocation {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface LSPHoverInfo {
  contents: string
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

interface ServerEntry {
  client: LSPClient
  def: LanguageServerDef
  workspace: string
  /** 该服务器独立的索引进度追踪器 */
  indexing: IndexingTracker
}

/** 等待项目索引进度的默认超时（毫秒） */
const INDEXING_TIMEOUT_MS = 30_000

export class LSPServerManager {
  private servers = new Map<string, ServerEntry>()

  /** 检测项目类型并启动对应 LSP 服务器 */
  async ensureServer(workspace: string): Promise<LSPClient> {
    if (!workspace) throw new Error("workspace 为空")

    const key = this.workspaceKey(workspace)
    const existing = this.servers.get(key)
    if (existing && existing.client.isRunning) return existing.client

    const def = detectLanguageServer(workspace)
    if (!def) throw new Error(`无法为 ${workspace} 找到合适的 LSP 服务器`)

    const resolution = await lspDependencyResolver.resolve(def)
    if (resolution.source === "none" || !resolution.command) {
      throw new Error(`LSP 服务器 ${def.displayName} 依赖未安装。可手动执行: npm install -g ${def.dependencies.map((d) => d.name).join(" ")}`)
    }

    const client = new LSPClient(def.id)
    client.start(resolution.command, resolution.args)

    const rootUri = pathToFileURL(workspace).href
    await client.initialize(rootUri)

    // 关联该服务器的索引进度追踪器（防止多 workspace 串扰）
    const indexing = new IndexingTracker()
    client.onRequest("window/workDoneProgress/create", (params) => {
      const p = params as { token?: string }
      if (p?.token) indexing.begin(p.token)
      return {}
    })
    client.onNotification("$/progress", (params) => {
      const p = params as { token?: string; value?: { kind?: string; message?: string } }
      if (p?.token && p.value?.kind) {
        indexing.onProgress(p.token, p.value.kind as "begin" | "report" | "end", p.value.message)
      }
    })

    this.servers.set(key, { client, def, workspace, indexing })
    return client
  }

  /** 等待项目索引进度就绪（超时降级不阻塞） */
  async waitForIndexing(workspace: string, timeoutMs: number = INDEXING_TIMEOUT_MS): Promise<boolean> {
    const entry = this.servers.get(this.workspaceKey(workspace))
    if (!entry) return true
    if (!entry.def.waitsForIndexing) return true
    return entry.indexing.waitForIndexing(timeoutMs)
  }

  /** 定位符号定义 */
  async getDefinition(workspace: string, filePath: string, line: number, col: number): Promise<LSPLocation[]> {
    const client = await this.ensureServer(workspace)
    const uri = this.fileUri(workspace, filePath)
    this.openDocumentForQuery(client, workspace, filePath, uri)
    const result = await client.goToDefinition(uri, line, col)
    if (!result) return []
    return this.normalizeLocations(result)
  }

  /** 查询所有引用 */
  async getReferences(workspace: string, filePath: string, line: number, col: number): Promise<LSPLocation[]> {
    const client = await this.ensureServer(workspace)
    const uri = this.fileUri(workspace, filePath)
    this.openDocumentForQuery(client, workspace, filePath, uri)
    const result = await client.findReferences(uri, line, col)
    if (!result) return []
    return this.normalizeLocations(result)
  }

  /** 查询实现位置（接口/抽象方法实现） */
  async getImplementations(workspace: string, filePath: string, line: number, col: number): Promise<LSPLocation[]> {
    const client = await this.ensureServer(workspace)
    const uri = this.fileUri(workspace, filePath)
    this.openDocumentForQuery(client, workspace, filePath, uri)
    const result = await client.findImplementations(uri, line, col)
    if (!result) return []
    return this.normalizeLocations(result)
  }

  /** 查询悬停类型信息 */
  async getHoverInfo(workspace: string, filePath: string, line: number, col: number): Promise<LSPHoverInfo | null> {
    const client = await this.ensureServer(workspace)
    const uri = this.fileUri(workspace, filePath)
    this.openDocumentForQuery(client, workspace, filePath, uri)
    const result: LSPHoverResult | null = await client.hover(uri, line, col)
    if (!result) return null
    const contents = Array.isArray(result.contents)
      ? result.contents.map((c: string | { value?: string }) => (typeof c === "string" ? c : c.value || "")).join("\n")
      : typeof result.contents === "string"
        ? result.contents
        : result.contents?.value || ""
    return { contents, range: result.range }
  }

  /** 获取文件符号大纲（层级结构） */
  async getSymbols(workspace: string, filePath: string): Promise<LSPDocumentSymbol[]> {
    const client = await this.ensureServer(workspace)
    const uri = this.fileUri(workspace, filePath)
    this.openDocumentForQuery(client, workspace, filePath, uri)
    const symbols = await client.documentSymbols(uri)
    return symbols ?? []
  }

  /** 获取文件诊断（publishDiagnostics 缓存） */
  async getDiagnostics(workspace: string, filePath: string) {
    const client = await this.ensureServer(workspace)
    const uri = this.fileUri(workspace, filePath)
    return client.getDiagnostics(uri)
  }

  /**
   * 编辑后诊断自检：对比编辑前后的诊断，识别新增问题
   * 流程：读取编辑前缓存诊断 → touchFile 触发 didChange → 等待诊断刷新 → 对比差异
   * LSP 不可用或超时时降级为未检查（不阻塞主流程）
   */
  async getDiagnosticsAfterEdit(
    workspace: string,
    filePath: string,
    options: { timeoutMs?: number } = {},
  ): Promise<DiagnosticCheckResult> {
    const startTime = Date.now()
    const timeoutMs = options.timeoutMs ?? 5_000
    const result: DiagnosticCheckResult = {
      checked: false,
      baselineAvailable: false,
      newErrors: [],
      newWarnings: [],
      elapsedMs: 0,
    }

    try {
      const client = await this.ensureServer(workspace)
      if (!client.isRunning) return result

      const uri = this.fileUri(workspace, filePath)
      // 编辑前快照：取当前已缓存的诊断作为基线
      const before = client.getDiagnostics(uri)
      result.baselineAvailable = before.length > 0

      // 触发诊断刷新（重新打开文件 → 服务器重新分析并推送诊断）
      const content = fs.readFileSync(path.resolve(workspace, filePath), "utf-8")
      const languageId = this.getFileLanguageId(workspace, filePath)
      client.openDocument(uri, languageId, content)

      // 等待服务器推送新诊断（超时返回 null，降级为未检查）
      const after = await client.waitForDiagnosticsUpdate(uri, timeoutMs)
      if (after === null) return result

      const diff = diffDiagnostics(before, after)
      result.checked = true
      result.newErrors = diff.newErrors
      result.newWarnings = diff.newWarnings
      result.elapsedMs = Date.now() - startTime
      return result
    } catch {
      // LSP 未就绪或读取失败：静默降级
      return result
    }
  }

  /** 关闭所有服务器 */
  stopAll(): void {
    for (const [, entry] of this.servers) {
      entry.client.stop()
    }
    this.servers.clear()
  }

  /**
   * 跨文件重命名符号 — 通过 LSP textDocument/rename 获取 WorkspaceEdit 并应用
   * 会先尝试 prepareRename 校验；prepareRename 不支持（部分服务器/位置）时
   * 直接发起 rename，由服务器决定是否可重命名
   * 失败返回 { success: false, error }，不抛出异常
   */
  async renameSymbol(workspace: string, filePath: string, line: number, col: number, newName: string): Promise<RenameResult> {
    const empty: RenameResult = { success: false, fileCount: 0, editCount: 0 }
    try {
      const client = await this.ensureServer(workspace)
      if (!client.isRunning) return { ...empty, error: "LSP 服务器未就绪" }

      const uri = this.fileUri(workspace, filePath)
      this.openDocumentForQuery(client, workspace, filePath, uri)

      // 打开项目源文件，确保 tsserver 有完整文件集（跨文件引用才完整）
      this.openProjectFiles(client, workspace)
      await this.waitForIndexing(workspace, 5_000)

      // 冷却等待：tsserver 处理 didOpen/didChange 是异步的，直接请求可能拿不到完整引用
      await sleep(800)

      // 校验符号可重命名（prepareRename 不支持时跳过，直接尝试 rename）
      const prepared = await client.prepareRename(uri, line, col)
      if (prepared === null || prepared === undefined) {
        // prepareRename 明确返回不可重命名 → 不直接失败，继续尝试 rename
        // 因为部分 LSP 实现 prepareRename 返回 null 但 rename 仍可工作
      }

      const workspaceEdit = (await client.rename(uri, line, col, newName)) as WorkspaceEditLike | null
      if (!workspaceEdit) return { ...empty, error: "该位置没有可重命名的符号（或 LSP 未返回重命名结果）" }

      return this.applyWorkspaceEdit(client, workspace, workspaceEdit)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // LSP 对不可重命名位置返回错误请求（如 "You cannot rename this element"）
      if (/cannot rename|not.*renam/i.test(message)) {
        return { ...empty, error: "该位置没有可重命名的符号" }
      }
      return { ...empty, error: `重命名失败: ${message}` }
    }
  }

  /**
   * 预热文件 — 通知 LSP 服务器文件已打开，让 LSP 开始分析
   */
  async touchFile(workspace: string, filePath: string): Promise<void> {
    try {
      const client = await this.ensureServer(workspace)
      const uri = this.fileUri(workspace, filePath)
      const content = fs.readFileSync(path.resolve(workspace, filePath), "utf-8")
      const languageId = this.getFileLanguageId(workspace, filePath)
      client.openDocument(uri, languageId, content)
    } catch {
      // LSP 预热失败不阻塞主流程
    }
  }

  /** 获取文件对应的 LSP languageId */
  getFileLanguageId(workspace: string, filePath: string): string {
    const entry = this.servers.get(this.workspaceKey(workspace))
    if (entry) return getLanguageId(entry.def, filePath)
    // 服务器未启动时按扩展名推断（兼容旧行为）
    const def = detectLanguageServer(workspace)
    return def ? getLanguageId(def, filePath) : detectLanguageByExt(filePath)
  }

  /** 重启指定 workspace 的语言服务器（依赖异常时恢复） */
  async restartServer(workspace: string): Promise<void> {
    const key = this.workspaceKey(workspace)
    const existing = this.servers.get(key)
    if (existing) {
      existing.client.stop()
      this.servers.delete(key)
    }
    await this.ensureServer(workspace)
  }

  // ── 内部工具 ──────────────────────────────────────

  private workspaceKey(workspace: string): string {
    return workspace.replace(/[/\\:]/g, "_")
  }

  private fileUri(workspace: string, filePath: string): string {
    return pathToFileURL(path.resolve(workspace, filePath)).href
  }

  private normalizeLocations(result: LSPLocationResult | LSPLocationResult[]): LSPLocation[] {
    const locations = Array.isArray(result) ? result : [result]
    return locations.map((loc: LSPLocationResult) => ({
      uri: loc.uri || loc.targetUri || "",
      range: loc.range || loc.targetSelectionRange || { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    }))
  }

  /** 查询前打开文档（tsserver 需要文件已打开才能响应对应行号查询），失败静默忽略 */
  private openDocumentForQuery(client: LSPClient, workspace: string, filePath: string, uri: string): void {
    try {
      const content = fs.readFileSync(path.resolve(workspace, filePath), "utf-8")
      const languageId = this.getFileLanguageId(workspace, filePath)
      client.openDocument(uri, languageId, content)
    } catch {
      // 打开文档失败不阻塞查询（服务器可能已缓存旧内容）
    }
  }

  /** 打开项目源文件上限（防止超大项目遍历过久） */
  private static readonly MAX_PROJECT_FILES = 200

  /** 需要打开的源文件扩展名（与 server-defs 语言映射对应） */
  private static readonly SOURCE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mts", "mjs"])

  /**
   * 打开项目源文件到 LSP 服务器，确保跨文件分析完整
   * 递归扫描 workspace（跳过 node_modules/dist 等），上限 MAX_PROJECT_FILES
   */
  private openProjectFiles(client: LSPClient, workspace: string): void {
    const skipDirs = new Set(["node_modules", "dist", "dist-electron", "release", ".git", ".mira", "data", "logs"])
    const collected: string[] = []

    const walk = (dir: string): void => {
      if (collected.length >= LSPServerManager.MAX_PROJECT_FILES) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (collected.length >= LSPServerManager.MAX_PROJECT_FILES) return
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name)) walk(path.join(dir, entry.name))
        } else if (entry.isFile()) {
          const ext = entry.name.split(".").pop()?.toLowerCase() || ""
          if (LSPServerManager.SOURCE_EXTENSIONS.has(ext)) {
            collected.push(path.join(dir, entry.name))
          }
        }
      }
    }
    walk(workspace)

    for (const file of collected) {
      try {
        const rel = path.relative(workspace, file)
        const content = fs.readFileSync(file, "utf-8")
        const languageId = this.getFileLanguageId(workspace, file)
        client.openDocument(this.fileUri(workspace, rel), languageId, content)
      } catch {
        // 单个文件打开失败不影响整体
      }
    }
  }

  /**
   * 应用 WorkspaceEdit 到磁盘文件
   * 支持 changes（uri → TextEdit[]）与 documentChanges（TextDocumentEdit）两种格式
   * 每个文件的编辑按行倒序应用（避免行号偏移）
   */
  private applyWorkspaceEdit(client: LSPClient, workspace: string, edit: WorkspaceEditLike): RenameResult {
    try {
      const fileEdits = new Map<string, TextEditLike[]>()

      if (edit.changes) {
        for (const [uri, edits] of Object.entries(edit.changes)) {
          if (Array.isArray(edits)) fileEdits.set(uri, edits)
        }
      }
      if (edit.documentChanges) {
        for (const change of edit.documentChanges) {
          const doc = change as { textDocument?: { uri?: string }; edits?: TextEditLike[] }
          if (doc.textDocument?.uri && Array.isArray(doc.edits)) {
            fileEdits.set(doc.textDocument.uri, doc.edits)
          }
        }
      }

      let editCount = 0
      for (const [uri, edits] of fileEdits) {
        const absPath = fileUriToPath(uri)
        if (!absPath || !fs.existsSync(absPath)) continue
        if (!edits.length) continue

        let content = fs.readFileSync(absPath, "utf-8")
        const lines = content.split("\n")

        // 按起始行倒序应用，保证行号不偏移
        const sorted = [...edits].sort((a, b) => (b.range?.start?.line ?? 0) - (a.range?.start?.line ?? 0))
        for (const te of sorted) {
          if (!te.range || te.newText === undefined) continue
          const start = te.range.start
          const end = te.range.end
          const before = lines.slice(0, start.line).join("\n")
          const after = lines.slice(end.line + 1).join("\n")
          const middle = lines.slice(start.line, end.line + 1).join("\n")
          // 计算行内裁剪（同源 offset 换算到列）
          const prefix = middle.slice(0, start.character)
          const suffix = middle.slice(end.character)
          const newText = te.newText
          const rebuilt = `${before}${before ? "\n" : ""}${prefix}${newText}${suffix}${after ? "\n" : ""}${after}`
          content = rebuilt
          editCount++
          lines.length = 0
          lines.push(...content.split("\n"))
        }

        fs.writeFileSync(absPath, content, "utf-8")
        // 通知 LSP 文件已更新
        client.notify("textDocument/didChange", {
          textDocument: { uri, version: Date.now() },
          contentChanges: [{ text: content }],
        })
      }

      return { success: true, fileCount: fileEdits.size, editCount }
    } catch (e) {
      return { success: false, fileCount: 0, editCount: 0, error: `应用重命名失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  }
}

/** LSP WorkspaceEdit 的最小形状 */
interface WorkspaceEditLike {
  changes?: Record<string, TextEditLike[]>
  documentChanges?: Array<Record<string, unknown>>
}

/** 重命名结果 */
export interface RenameResult {
  /** 是否成功 */
  success: boolean
  /** 修改的文件数 */
  fileCount: number
  /** 修改总数（替换点） */
  editCount: number
  /** 失败信息（success=false 时） */
  error?: string
}

/** LSP TextEdit 的最小形状 */
interface TextEditLike {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  newText: string
}

/** file:// URI → 本地绝对路径（Windows 兼容） */
function fileUriToPath(uri: string): string | null {
  try {
    if (!uri.startsWith("file://")) return null
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

/** 短暂等待（毫秒） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 根据扩展名检测语言（服务器未启动时的降级推断） */
function detectLanguageByExt(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || ""
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact",
    py: "python", java: "java", go: "go", rs: "rust", cpp: "cpp", c: "c",
    json: "json", md: "markdown", html: "html", css: "css",
  }
  return map[ext] || "plaintext"
}

export const lspManager = new LSPServerManager()
