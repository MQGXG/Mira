import { z } from "zod"
import { Effect } from "effect"

export interface ToolContext {
  sessionID: string
  workspace: string
  mode: string
  agent: string
  assistantMessageID: string
  toolCallID: string
  shell?: string
  abort?: AbortSignal
  /** LLM 凭据透传（与 shared/tool.ts 的 ToolContext 对齐，供委托/子 Agent 工具继承父配置） */
  apiKey?: string
  apiUrl?: string
  provider?: string
  model?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  metadata?(input: { title?: string; metadata?: Record<string, unknown> }): void
}

export interface ToolResult {
  success: boolean
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

/** 参数验证错误 — 类似 OpenCode 的 InvalidArgumentsError */
export class InvalidArgumentsError extends Error {
  readonly _tag = "ToolInvalidArgumentsError"
  constructor(
    public readonly tool: string,
    detail: string,
  ) {
    super(`工具 "${tool}" 参数无效: ${detail}`)
    this.name = "ToolInvalidArgumentsError"
  }
}

/** 工具定义 */
export interface Def {
  id: string
  description: string
  parameters: Record<string, unknown>
  jsonSchema?: Record<string, unknown>
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
  permission?: string
  formatValidationError?(error: unknown): string
  /** 编译一次的参数验证器 */
  validation?: (args: Record<string, unknown>) => Record<string, unknown> | Error
}

/** 延迟初始化包装 */
export interface Info {
  id: string
  init(): Effect.Effect<Def>
}

/** 定义工具，支持 Effect 依赖注入 */
export function define<R>(
  id: string,
  init: Effect.Effect<Omit<Def, "id">, never, R>,
): Effect.Effect<Info, never, R> {
  return Effect.map(init, (def) => ({
    id,
    init: () => Effect.succeed({ ...def, id }),
  }))
}

/** 初始化 Info → Def */
export function init(info: Info): Effect.Effect<Def> {
  return Effect.map(info.init(), (def) => ({ ...def, id: info.id }))
}

/** 转为 OpenAI 工具格式 */
export function toOpenAISchema(def: Def): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: def.id,
      description: def.description,
      parameters: def.jsonSchema || def.parameters || { type: "object", properties: {} },
    },
  }
}

/** 获取 JSON Schema */
export function getJsonSchema(def: Def): Record<string, unknown> {
  return def.jsonSchema || def.parameters || { type: "object", properties: {} }
}

/** 将 Effect Def 转为旧式 ToolDef 兼容格式 */
export function toLegacyToolDef(effectDef: Def) {
  const schema = getJsonSchema(effectDef)
  interface SchemaProperty { type?: string; description?: string }
  const props = (schema.properties || {}) as Record<string, SchemaProperty>
  const shape: Record<string, z.ZodType> = {}
  for (const [k, v] of Object.entries(props)) {
    const t = v.type === "string" ? z.string()
      : v.type === "number" ? z.number()
      : v.type === "boolean" ? z.boolean()
      : v.type === "integer" ? z.number().int()
      : z.any()
    shape[k] = v.description ? t.describe(v.description) : t
  }

  return {
    name: effectDef.id,
    description: effectDef.description,
    parameters: schema,
    jsonSchema: schema,
    inputSchema: Object.keys(shape).length > 0 ? z.object(shape) : z.object({}),
    outputSchema: { parse: (v: unknown) => v },
    execute: async (input: Record<string, unknown>, ctx: ToolContext) => {
      try {
        if (effectDef.validation) {
          const validated = effectDef.validation(input)
          if (validated instanceof Error) {
            return { success: false, error: validated.message }
          }
          return await effectDef.execute(validated, ctx)
        }
        return await effectDef.execute(coerceArgs(effectDef.id, input, schema), ctx)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, error: msg }
      }
    },
    permission: effectDef.permission,
  }
}

/** 参数类型自动转换 */
export function coerceArgs(
  name: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema.properties || {}) as Record<string, any>
  const out = { ...args }
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "string") continue
    const prop = props[key]
    if (!prop || !prop.type) continue
    const types = Array.isArray(prop.type) ? prop.type : [prop.type]
    for (const t of types) {
      if (t === "integer" || t === "number") {
        const f = parseFloat(value)
        if (!Number.isNaN(f)) { out[key] = f; break }
      }
      if (t === "boolean") {
        const low = value.trim().toLowerCase()
        if (low === "true") { out[key] = true; break }
        if (low === "false") { out[key] = false; break }
      }
    }
  }
  return out
}

/** 执行工具参数验证（编译一次 Schema） */
export function createValidator(fields: Record<string, { type: string; required?: boolean }>) {
  return (args: Record<string, unknown>): Record<string, unknown> | Error => {
    for (const [key, field] of Object.entries(fields)) {
      if (field.required !== false && (args[key] === undefined || args[key] === null)) {
        return new InvalidArgumentsError("validation", `缺少必填参数 "${key}"`)
      }
    }
    return args
  }
}
