/**
 * 工具定义工厂
 * 参考 OpenCode Tool.define + MAF FunctionTool
 *
 * 增强点：
 * 1. 工具级 maxOutputLength — 每个工具可配置输出上限
 * 2. 结构化错误分类 — RecoverableError vs FatalError
 * 3. 执行耗时追踪
 */

import type { z } from "zod"
import { zodToJsonSchema as zodToJsonSchemaConverter } from "./zod-converter"
import * as fs from "fs"
import * as path from "path"

export interface ToolContext {
  sessionID: string
  workspace: string
  mode: string
  agent: string
  assistantMessageID: string
  toolCallID: string
  shell?: string
  signal?: AbortSignal
  /** LLM 凭据透传（由 buildToolContext 从 Agent 配置注入，供委托/子 Agent 等工具继承父配置） */
  apiKey?: string
  apiUrl?: string
  provider?: string
  model?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

export interface ToolResult {
  success: boolean
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

export type Content =
  | { type: "text"; text: string }
  | { type: "file"; data: string; mime: string; name?: string }

import type { ToolCategory } from "../tools/shared/tool-meta"

export interface ToolDef<Input = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: z.ZodType<Input>
  outputSchema: z.ZodType<Output>
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>
  toModelOutput?(input: Input, output: Output): Content[]
  permission?: string
  /** 兼容旧格式：直接提供 JSON Schema（而非 inputSchema），仅供未迁移工具使用 */
  parameters?: Record<string, unknown>
  /** 工具级输出截断上限（字符数），默认 50000 */
  maxOutputLength?: number
  /** 只读工具（不会修改任何状态） */
  isReadOnly?: boolean
  /** 是否支持并行执行（覆盖 tool-meta 全局配置） */
  isConcurrencySafe?: boolean
  /** 单次执行超时（毫秒） */
  timeout?: number
  /** 工具分类 */
  category?: ToolCategory
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

/** 结构化工具执行错误码（对齐 dsh 管线错误规范化） */
export const TOOL_ABORTED = "ABORTED"
export const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH"
export const TOOL_NOT_FOUND = "TOOL_NOT_FOUND"

/** 带错误码的工具结果扩展（批 10：结构化执行结果） */
export interface ToolExecutionResult extends ToolResult {
  /** 结构化错误码（失败时填充） */
  code?: string
  /** 本次执行是否因取消而中止 */
  aborted?: boolean
}

/** 结构化工具执行输入（对齐 dsh ToolExecutionInput 简化面） */
export interface ToolExecutionInput {
  id: string
  name: string
  args: Record<string, unknown>
  /** 调用方取消信号（cancel 传播到 body） */
  signal?: AbortSignal
}

/** 一次性取消编排（对齐 dsh ToolCancellationState：callerSignal + bodyInvoked） */
export interface ToolCancellationState {
  callerSignal?: AbortSignal
  bodyInvoked: boolean
}

/** 取消前已终止的工具结果 */
export function toolAbortedBeforeDispatchResult(): ToolExecutionResult {
  return {
    success: false,
    error: "Tool execution was aborted before dispatch",
    code: TOOL_ABORTED_BEFORE_DISPATCH,
    aborted: true,
  }
}

/** 工具未找到的错误结果（携带可读原因） */
export function toolErrorResult(error: unknown, code = TOOL_NOT_FOUND): ToolExecutionResult {
  const msg = error instanceof Error ? error.message : String(error)
  return { success: false, error: msg, code }
}

/** 中止的工具结果（body 已开始，被取消中断） */
export function toolAbortedResult(): ToolExecutionResult {
  return {
    success: false,
    error: "Tool execution was aborted",
    code: TOOL_ABORTED,
    aborted: true,
  }
}

export interface Settlement {
  result: ToolResult
  content: Content[]
}

/**
 * 可恢复错误 — 参数校验失败等，LLM 可以重试
 * 参考 MiMo Code 的 RecoverableError
 */
export class RecoverableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RecoverableError"
  }
}

/**
 * 致命错误 — 工具执行失败，不可重试
 */
export class FatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FatalError"
  }
}

// 运行时的工具元数据
const runtimeMap = new WeakMap<ToolDef, {
  jsonSchema: Record<string, unknown>
  outputJsonSchema: Record<string, unknown>
}>()

export function make<Input, Output>(
  config: {
    name: string
    description: string
    inputSchema: z.ZodType<Input>
    outputSchema: z.ZodType<Output>
    execute(input: Input, ctx: ToolContext): Promise<ToolResult>
    toModelOutput?(input: Input, output: Output): Content[]
    permission?: string
    maxOutputLength?: number
    isReadOnly?: boolean
    isConcurrencySafe?: boolean
    timeout?: number
    category?: ToolCategory
  }
): ToolDef<Input, Output> {
  const def: ToolDef<Input, Output> = {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    execute: config.execute,
    toModelOutput: config.toModelOutput,
    permission: config.permission,
    maxOutputLength: config.maxOutputLength,
    isReadOnly: config.isReadOnly,
    isConcurrencySafe: config.isConcurrencySafe,
    timeout: config.timeout,
    category: config.category,
  }

  const jsonschema = zodToJsonSchemaConverter(config.inputSchema)
  const outputJsonSchema = zodToJsonSchemaConverter(config.outputSchema)
  if (!jsonschema.type) jsonschema.type = "object"
  if (!jsonschema.properties) jsonschema.properties = {}
  runtimeMap.set(def, {
    jsonSchema: jsonschema,
    outputJsonSchema,
  })

  return def
}

export function getJsonSchema(def: ToolDef): Record<string, unknown> {
  const cached = runtimeMap.get(def)?.jsonSchema
  if (cached) {
    if (cached.type === null || cached.type === undefined) {
      console.error(`[tool] ${def.name} schema has invalid type:`, JSON.stringify(cached))
      return { type: "object", properties: cached.properties || {} }
    }
    return cached
  }
  if ("inputSchema" in def) {
    const ischema = def.inputSchema as unknown as { toJSONSchema?: () => Record<string, unknown> }
    if (typeof ischema?.toJSONSchema === "function") {
      try {
        const raw = ischema.toJSONSchema()
        const cleaned: Record<string, unknown> = { type: raw.type || "object" }
        if (raw.properties) cleaned.properties = raw.properties
        if (raw.required) cleaned.required = raw.required
        if (raw.items) cleaned.items = raw.items
        return cleaned
      } catch { /* JSON Schema 直接传递不转换 */ }
    }
  }
  if ("parameters" in def) {
    const p = (def as any).parameters as Record<string, unknown>
    if (p && typeof p === "object" && (p as any).type === "object") return p
  }
  return { type: "object", properties: {} }
}

export function toOpenAISchema(def: ToolDef): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: getJsonSchema(def),
    },
  }
}

// ── 统一输出截断（参考 OpenCode truncate.ts）──────────────────

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

export interface TruncateOutputOptions {
  /** 最大行数，默认 2000 */
  maxLines?: number
  /** 最大字节数（utf-8），默认 50KB */
  maxBytes?: number
  /** 截断方向：保留头部（head）或尾部（tail），默认 head */
  direction?: "head" | "tail"
  /** 工作区目录；提供时超限输出落盘到 `<workspace>/.task_outputs/tool-results/` */
  workspace?: string
  /** 落盘文件名主干（通常为 toolCallID） */
  id?: string
}

export interface TruncatedOutput {
  content: string
  truncated: boolean
  outputPath?: string
  /** 被截掉的行数（仅 truncated 时有意义） */
  removedLines?: number
}

/**
 * 统一工具输出截断：超行数/字节则截断为 preview，完整输出落盘，
 * 追加读取提示（供 Grep/Read 查看全文）。
 * 纯函数，无副作用（落盘失败静默降级为纯正文截断）。
 */
export function truncateToolOutput(text: string, opts: TruncateOutputOptions = {}): TruncatedOutput {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const direction = opts.direction ?? "head"
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false }
  }

  const out: string[] = []
  let bytes = 0
  let hitBytes = false

  if (direction === "head") {
    for (let i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
      if (bytes + size > maxBytes) { hitBytes = true; break }
      out.push(lines[i])
      bytes += size
    }
  } else {
    for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) { hitBytes = true; break }
      out.unshift(lines[i])
      bytes += size
    }
  }

  const removedUnits = hitBytes ? totalBytes - bytes : lines.length - out.length
  const removedLines = hitBytes ? 0 : lines.length - out.length
  const preview = out.join("\n")

  // 完整输出落盘
  let outputPath: string | undefined
  if (opts.workspace && opts.id) {
    try {
      const dir = path.join(opts.workspace, ".task_outputs", "tool-results")
      fs.mkdirSync(dir, { recursive: true })
      outputPath = path.join(dir, `${opts.id}.txt`)
      fs.writeFileSync(outputPath, text, "utf-8")
    } catch {
      outputPath = undefined
    }
  }

const fullHint = outputPath
    ? `\n输出已完整保存至: ${outputPath}\nUse Grep to search the full content, Read with offset/limit to view sections, or consider delegating to a subagent for large output.`
    : "\n输出过大。可考虑委派子代理处理，或用 Grep/Read 分片查看。"

  const body = direction === "head"
    ? `${preview}\n\n...[${removedUnits} ${hitBytes ? "bytes" : "lines"} truncated]...`
    : `...${removedUnits} ${hitBytes ? "bytes" : "lines"} truncated...\n\n${preview}`

  return {
    content: `${body}${fullHint}`,
    truncated: true,
    outputPath,
    removedLines,
  }
}

/**
 * 执行工具 — 带耗时追踪 + 输出截断 + 错误分类
 * 参考 MAF FunctionTool.invoke() 的计时和解析逻辑
 *
 * 错误分类：
 * - RecoverableError: 参数校验失败等，LLM 可以重试
 * - FatalError: 工具执行失败，不可重试
 * - 其他 Error: 未知错误，标记为可恢复（给 LLM 重试机会）
 */
export async function settle(
  def: ToolDef,
  call: ToolCall,
  ctx: ToolContext
): Promise<Settlement> {
  const startTime = Date.now()
  const maxOutput = def.maxOutputLength || 50000

  const schema = getJsonSchema(def)
  const coercedInput = coerceToolArgs(def.name, call.input, schema)
  const parseResult = def.inputSchema
    ? def.inputSchema.safeParse(coercedInput)
    : { success: true as const, data: coercedInput }
  if (!parseResult.success) {
    // 参数校验失败 = 可恢复错误，LLM 可以修正参数重试
    return {
      result: {
        success: false,
        error: `Invalid input: ${parseResult.error.message}`,
        metadata: { elapsed: Date.now() - startTime, errorType: "recoverable" },
      },
      content: [{ type: "text", text: `Invalid input for ${def.name}: ${parseResult.error.message}\nPlease fix the arguments and retry.` }],
    }
  }

  try {
    const result = await def.execute(parseResult.data, ctx)
    const elapsed = Date.now() - startTime

    // 统一输出截断：超行/超字节 → preview + 落盘全量（参考 OpenCode truncate）
    let output = result.output ?? (result.success ? "" : result.error ?? "")
    let truncated = false
    let outputPath: string | undefined
    const truncation = truncateToolOutput(output, {
      maxLines: 2000,
      maxBytes: DEFAULT_MAX_BYTES,
      workspace: ctx.workspace || undefined,
      id: call.id,
    })
    if (truncation.truncated) {
      output = truncation.content
      outputPath = truncation.outputPath
      truncated = true
    }
    // 工具级字符上限二次裁剪（maxOutputLength 语义为字符数，保持向后兼容）
    if (output.length > maxOutput) {
      output = output.slice(0, maxOutput) + `\n\n[Output truncated at ${maxOutput} chars]`
      truncated = true
    }

    const parsed = def.outputSchema ? def.outputSchema.parse(output) : output
    const content = def.toModelOutput
      ? def.toModelOutput(parseResult.data, parsed)
      : [{ type: "text" as const, text: output || result.error || "" }]

    return {
      result: {
        ...result,
        output,
        metadata: {
          ...result.metadata,
          elapsed,
          truncated,
          ...(outputPath ? { outputPath } : {}),
        },
      },
      content,
    }
  } catch (e) {
    const elapsed = Date.now() - startTime
    const message = e instanceof Error ? e.message : String(e)
    const errorMsg = sanitizeToolError(message)

    // 区分错误类型
    let errorType: "recoverable" | "fatal" = "recoverable"
    if (e instanceof FatalError) {
      errorType = "fatal"
    } else if (e instanceof RecoverableError) {
      errorType = "recoverable"
    } else if (message.includes("ENOENT") || message.includes("EACCES") || message.includes("EPERM")) {
      // 文件系统错误通常是永久性的
      errorType = "fatal"
    }

    return {
      result: {
        success: false,
        error: errorMsg,
        metadata: { elapsed, errorType },
      },
      content: [{
        type: "text",
        text: errorType === "recoverable"
          ? `${errorMsg}\nThis error may be recoverable — try a different approach.`
          : errorMsg,
      }],
    }
  }
}

export const withPermission = <I, O>(def: ToolDef<I, O>, permission: string): ToolDef<I, O> => ({
  ...def,
  permission,
})

const ROLE_TAG_RE = /<\/?(?:tool_call|function_call|result|response|output|input|system|assistant|user)>/gi
const FENCE_OPEN_RE = /^\s*```(?:json|xml|html|markdown)?\s*/gim
const FENCE_CLOSE_RE = /\s*```\s*$/gim
const CDATA_RE = /<!\[CDATA\[.*?\]\]>/gis
const MAX_TOOL_ERROR_LEN = 2000

export function sanitizeToolError(errorMsg: string): string {
  if (!errorMsg) return '[TOOL_ERROR] '
  let s = errorMsg
    .replace(ROLE_TAG_RE, '')
    .replace(FENCE_OPEN_RE, '')
    .replace(FENCE_CLOSE_RE, '')
    .replace(CDATA_RE, '')
  if (s.length > MAX_TOOL_ERROR_LEN) s = s.slice(0, MAX_TOOL_ERROR_LEN - 3) + '...'
  return `[TOOL_ERROR] ${s}`
}

function coerceValue(value: string, expected: string | string[]): unknown {
  if (Array.isArray(expected)) {
    for (const t of expected) {
      const c = coerceValue(value, t)
      if (c !== value) return c
    }
    return value
  }
  if (expected === 'integer' || expected === 'number') {
    const f = parseFloat(value)
    if (!Number.isNaN(f)) return Number.isInteger(f) ? Math.trunc(f) : f
  }
  if (expected === 'boolean') {
    const low = value.trim().toLowerCase()
    if (low === 'true') return true
    if (low === 'false') return false
  }
  return value
}

export function coerceToolArgs(name: string, args: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  interface SchemaProperty { type?: string | string[] }
  const props = (schema.properties || {}) as Record<string, SchemaProperty>
  const out = { ...args }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue
    const prop = props[key]
    if (!prop || !prop.type) continue
    const coerced = coerceValue(value, prop.type)
    if (coerced !== value) out[key] = coerced
  }
  return out
}
