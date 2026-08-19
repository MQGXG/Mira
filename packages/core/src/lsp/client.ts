/**
 * LSP JSON-RPC 客户端 — 通过 stdio 与语言服务器通信
 * 支持：响应处理 / server→client 请求分发 / notification 通知分发 / $/progress 索引追踪
 */

import { spawn, type ChildProcess } from "child_process"

let msgId = 1

/** LSP JSON-RPC 消息（按需字段） */
interface LSPMessage {
  id?: number
  method?: string
  params?: unknown
  error?: { message: string }
  result?: unknown
}

/** 定位结果 — 兼容 Location / LocationLink 两种返回 */
export interface LSPLocationResult {
  uri?: string
  targetUri?: string
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
  targetSelectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

/** 悬停信息 — contents 可能是 string 或 MarkedString[] 或 MarkedString */
export interface LSPHoverResult {
  contents?: string | Array<string | { value?: string }> | { value?: string }
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

/** 文档符号（层级结构，DocumentSymbol） */
export interface LSPDocumentSymbol {
  name: string
  kind: number
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
  selectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } }
  children?: LSPDocumentSymbol[]
}

/** 诊断信息 */
export interface LSPDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  severity?: number
  message: string
  /** 诊断代码（如 TS2322） */
  code?: string | number
}

type NotificationHandler = (params: unknown) => void
type RequestHandler = (params: unknown) => unknown

export class LSPClient {
  private process: ChildProcess | null = null
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer = Buffer.alloc(0)
  private contentLength = -1
  private _capabilities: Record<string, unknown> | null = null
  private serverName: string
  private notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private requestHandlers = new Map<string, RequestHandler>()

  constructor(serverName: string) {
    this.serverName = serverName
  }

  get capabilities(): Record<string, unknown> | null { return this._capabilities }
  get isRunning(): boolean { return this.process !== null && !this.process.killed }

  /** 注册 notification 处理器（如 $/progress、window/logMessage） */
  onNotification(method: string, handler: NotificationHandler): void {
    const set = this.notificationHandlers.get(method) ?? new Set()
    set.add(handler)
    this.notificationHandlers.set(method, set)
  }

  /** 注册 server→client 请求处理器（如 window/workDoneProgress/create、workspace/configuration） */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  /** 启动语言服务器 */
  start(command: string, args: string[] = []): void {
    if (this.process) this.stop()

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.process.on("exit", (code) => {
      this.process = null
      for (const [, { reject }] of this.pending) {
        reject(new Error(`LSP 服务器已退出 (code: ${code})`))
      }
      this.pending.clear()
    })

    this.process.stdout!.on("data", (data: Buffer) => this.handleData(data))
    this.process.stderr?.on("data", () => {})
  }

  /** 发送请求 */
  async request(method: string, params: unknown): Promise<unknown> {
    const id = msgId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  /** 发送通知 */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  /** 初始化 */
  async initialize(rootUri: string): Promise<void> {
    const result = (await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
          completion: { completionItem: { snippetSupport: true } },
          documentSymbol: {
            dynamicRegistration: true,
            hierarchicalDocumentSymbolSupport: true,
            symbolKind: { valueSet: listSymbolKinds() },
          },
          rename: { dynamicRegistration: true, prepareSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          didChangeConfiguration: { dynamicRegistration: true },
          symbol: { dynamicRegistration: true },
        },
        window: {
          workDoneProgress: true, // 启用 $/progress 通知
        },
      },
    })) as Record<string, unknown>
    this._capabilities = (result?.capabilities as Record<string, unknown> | undefined) ?? null
    this.notify("initialized", {})

    // 内置：缓存 publishDiagnostics 通知（索引进度由 manager 按 server 关联追踪）
    this.onNotification("textDocument/publishDiagnostics", (params) => this.handlePublishDiagnostics(params))
  }

  /** 打开文档（幂等：已打开则用 didChange 同步最新内容，避免重复 didOpen 干扰服务器） */
  openDocument(uri: string, languageId: string, text: string): void {
    if (this._openDocuments.has(uri)) {
      const version = (this._openVersions.get(uri) ?? 1) + 1
      this._openVersions.set(uri, version)
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
      return
    }
    this._openDocuments.add(uri)
    this._openVersions.set(uri, 1)
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    })
  }

  /** 是否已打开该文档 */
  isDocumentOpen(uri: string): boolean {
    return this._openDocuments.has(uri)
  }

  /** 关闭文档 */
  closeDocument(uri: string): void {
    this._openDocuments.delete(uri)
    this._openVersions.delete(uri)
    this.notify("textDocument/didClose", { textDocument: { uri } })
  }

  /** 查询定义 */
  async goToDefinition(uri: string, line: number, character: number): Promise<LSPLocationResult | LSPLocationResult[] | null> {
    return (await this.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    })) as LSPLocationResult | LSPLocationResult[] | null
  }

  /** 查询引用 */
  async findReferences(uri: string, line: number, character: number): Promise<LSPLocationResult | LSPLocationResult[] | null> {
    return (await this.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    })) as LSPLocationResult | LSPLocationResult[] | null
  }

  /** 查询实现（接口/抽象方法实现位置） */
  async findImplementations(uri: string, line: number, character: number): Promise<LSPLocationResult | LSPLocationResult[] | null> {
    return (await this.request("textDocument/implementation", {
      textDocument: { uri },
      position: { line, character },
    })) as LSPLocationResult | LSPLocationResult[] | null
  }

  /** 查询悬停信息 */
  async hover(uri: string, line: number, character: number): Promise<LSPHoverResult | null> {
    return (await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    })) as LSPHoverResult | null
  }

  /** 获取文档符号列表（层级结构） */
  async documentSymbols(uri: string): Promise<LSPDocumentSymbol[] | null> {
    const result = await this.request("textDocument/documentSymbol", {
      textDocument: { uri },
    })
    return normalizeDocumentSymbols(result)
  }

  /** 查询 semantic tokens（用于代码结构分析） */
  async semanticTokens(uri: string): Promise<unknown> {
    return this.request("textDocument/semanticTokens/full", {
      textDocument: { uri },
    })
  }

  /** 准备重命名 — 返回可重命名的位置范围（不支持时返回 null） */
  async prepareRename(uri: string, line: number, character: number): Promise<unknown> {
    return this.request("textDocument/prepareRename", {
      textDocument: { uri },
      position: { line, character },
    })
  }

  /** 重命名符号 */
  async rename(uri: string, line: number, character: number, newName: string): Promise<unknown> {
    return this.request("textDocument/rename", {
      textDocument: { uri },
      position: { line, character },
      newName,
    })
  }

  /** 获取文件诊断（textDocument/publishDiagnostics 缓存） */
  getDiagnostics(uri: string): LSPDiagnostic[] {
    return this._diagnosticsCache.get(uri) ?? []
  }

  /**
   * 等待指定文件的诊断刷新到新版本
   * 编辑文件后调用：先 touchFile 触发 didChange → 服务器推送新诊断，本方法等待刷新完成
   * @param uri 文件 URI
   * @param timeoutMs 最大等待时间（毫秒）
   * @returns 刷新后的诊断（即使为空数组）；超时返回 null
   */
  async waitForDiagnosticsUpdate(uri: string, timeoutMs = 5_000): Promise<LSPDiagnostic[] | null> {
    const fromGeneration = this._diagnosticsGeneration.get(uri) ?? 0

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs)

      const check = (): void => {
        const current = this._diagnosticsGeneration.get(uri) ?? 0
        if (current > fromGeneration) {
          clearTimeout(timer)
          resolve(this._diagnosticsCache.get(uri) ?? [])
        }
      }

      this._diagnosticsWaiters.set(uri, check)
      check()
    })
  }

  /** 停止 */
  stop(): void {
    if (!this.process) return
    try { this.notify("shutdown", null); this.notify("exit", null) } catch { /* process already dead */ }
    this.process.kill()
    this.process = null
    this._capabilities = null
    this._diagnosticsCache.clear()
    this._diagnosticsGeneration.clear()
    this._diagnosticsWaiters.clear()
    this._openDocuments.clear()
    this._openVersions.clear()
  }

  // ── 内部实现 ──────────────────────────────────────

  private _diagnosticsCache = new Map<string, LSPDiagnostic[]>()
  private _diagnosticsGeneration = new Map<string, number>()
  private _diagnosticsWaiters = new Map<string, () => void>()
  private _openDocuments = new Set<string>()
  private _openVersions = new Map<string, number>()

  private send(message: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return
    const json = JSON.stringify(message)
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`)
  }

  private handleData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])
    this.tryParse()
  }

  private tryParse(): void {
    for (;;) {
      if (this.contentLength < 0) {
        // 查找 header 结束标记
        const idx = this.buffer.indexOf("\r\n\r\n")
        if (idx === -1) return
        const header = this.buffer.subarray(0, idx).toString()
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (match) this.contentLength = parseInt(match[1], 10)
        else return
        this.buffer = this.buffer.subarray(idx + 4) // 跳过 \r\n\r\n
      }

      if (this.buffer.length >= this.contentLength) {
        const body = this.buffer.subarray(0, this.contentLength).toString()
        this.buffer = this.buffer.subarray(this.contentLength)
        this.contentLength = -1
        this.processMessage(body)
      } else {
        return
      }
    }
  }

  private processMessage(body: string): void {
    try {
      const msg = JSON.parse(body) as LSPMessage

      // 1. 响应消息：id 存在且在 pending 中
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
        return
      }

      // 2. server→client 请求：id 存在但不在 pending 中，需回复响应
      if (msg.id !== undefined && msg.method) {
        const handler = this.requestHandlers.get(msg.method)
        let result: unknown = null
        try {
          result = handler ? handler(msg.params) : {}
        } catch {
          result = {}
        }
        this.send({ jsonrpc: "2.0", id: msg.id, result })
        return
      }

      // 3. 通知消息：无 id
      if (msg.method) {
        const handlers = this.notificationHandlers.get(msg.method)
        if (handlers) {
          for (const handler of handlers) {
            try { handler(msg.params) } catch { /* 通知处理异常不中断连接 */ }
          }
        }
      }
    } catch { /* 消息处理异常不中断连接 */ }
  }

  /** 缓存 publishDiagnostics 通知（带 generation 递增，支持等待刷新） */
  private handlePublishDiagnostics(params: unknown): void {
    const p = params as { uri?: string; diagnostics?: LSPDiagnostic[] }
    if (p?.uri && Array.isArray(p.diagnostics)) {
      this._diagnosticsCache.set(p.uri, p.diagnostics)
      this._diagnosticsGeneration.set(p.uri, (this._diagnosticsGeneration.get(p.uri) ?? 0) + 1)
      const waiter = this._diagnosticsWaiters.get(p.uri)
      if (waiter) waiter()
    }
  }
}

/** documentSymbol 结果归一化：兼容扁平数组（SymbolInformation）与层级结构（DocumentSymbol） */
function normalizeDocumentSymbols(result: unknown): LSPDocumentSymbol[] | null {
  if (!Array.isArray(result)) return null
  const out: LSPDocumentSymbol[] = []
  for (const item of result) {
    const sym = item as Record<string, unknown>
    // 扁平 SymbolInformation：无 range，只有 location
    if (sym.location && !sym.range) {
      const loc = sym.location as { range?: LSPDocumentSymbol["range"] }
      out.push({
        name: toString(sym.name),
        kind: Number(sym.kind ?? 0),
        range: loc.range,
        selectionRange: loc.range,
        children: normalizeDocumentSymbols(sym.children) ?? undefined,
      })
    } else {
      out.push({
        name: toString(sym.name),
        kind: Number(sym.kind ?? 0),
        range: sym.range as LSPDocumentSymbol["range"],
        selectionRange: sym.selectionRange as LSPDocumentSymbol["range"],
        children: normalizeDocumentSymbols(sym.children) ?? undefined,
      })
    }
  }
  return out
}

/** 安全转字符串：仅接受字符串/数字，其余返回空串（避免对象默认 stringify） */
function toString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : ""
}

/** LSP SymbolKind 取值列表（1~26） */
function listSymbolKinds(): number[] {
  return Array.from({ length: 26 }, (_, i) => i + 1)
}
