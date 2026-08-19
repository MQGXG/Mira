/**
 * ToolMaterializer — 工具物化（JSON Schema 转换 + AI SDK 格式化 + settle）
 * 从 registry.ts 拆分，职责单一
 */

import { z } from "zod"
import type { ToolDef, ToolContext, ToolResult, ToolCall, Content } from "../shared/tool";
import { settle, getJsonSchema } from "../shared/tool"
import type { PermissionSet } from "./permission"
import * as ToolEffect from "../shared/tool-effect"
import type { LLMToolSet } from "../llm/client"

export interface Materialization {
  definitions: LLMToolSet
  settle(call: ToolCall, ctx: ToolContext): Promise<{ result: ToolResult; content: Content[] }>
}

export interface ModelFilter {
  providerID: string
  modelID: string
}

export class ToolMaterializer {
  /** JSON Schema → Zod 转换 */
  jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
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
    return z.object(shape)
  }

  /** ToolDef → AI SDK 工具格式 */
  toAISDKTool(t: ToolDef): { description: string; inputSchema: z.ZodType } {
    return {
      description: t.description,
      inputSchema: this.jsonSchemaToZod(getJsonSchema(t)),
    }
  }

  /** 按模型过滤工具 */
  filterByModel(tools: Map<string, ToolDef>, modelFilter: ModelFilter): ToolDef[] {
    const usePatch = modelFilter.modelID.includes("gpt-") && !modelFilter.modelID.includes("gpt-4")
    return Array.from(tools.values()).filter((tool) => {
      if (tool.name === "edit_file" && usePatch) return false
      if (tool.name === "apply_patch" && !usePatch) return false
      return true
    })
  }

  /** 物化所有工具，可选按权限过滤 */
  materialize(
    tools: Map<string, ToolDef>,
    effectDefs: Map<string, ToolEffect.Def>,
    permissions?: PermissionSet,
  ): Materialization {
    const allDefs: ToolDef[] = [
      ...tools.values(),
      ...Array.from(effectDefs.values()).map((et) => ToolEffect.toLegacyToolDef(et) as unknown as ToolDef),
    ]
    const allowed = permissions
      ? allDefs.filter((t) => permissions.isAllowed(t.name, t.permission))
      : allDefs

    const toolSet: LLMToolSet = {}
    for (const t of allowed) {
      toolSet[t.name] = this.toAISDKTool(t)
    }

    return {
      definitions: toolSet,
      settle: async (call: ToolCall, ctx: ToolContext) => {
        const def = tools.get(call.name)
        if (def) {
          if (permissions && !permissions.isAllowed(def.name, def.permission)) {
            return {
              result: { success: false, error: `Permission denied: ${call.name}` },
              content: [{ type: "text" as const, text: `Permission denied: ${call.name}` }],
            }
          }
          return settle(def, call, ctx)
        }

        const effectDef = effectDefs.get(call.name)
        if (effectDef) {
          if (permissions && !permissions.isAllowed(effectDef.id, effectDef.permission)) {
            return {
              result: { success: false, error: `Permission denied: ${call.name}` },
              content: [{ type: "text" as const, text: `Permission denied: ${call.name}` }],
            }
          }
          const coercedArgs = ToolEffect.coerceArgs(call.name, call.input, effectDef.jsonSchema || {})
          try {
            const result = await effectDef.execute(coercedArgs, ctx)
            const content: Content[] = [{ type: "text", text: result.output || result.error || "" }]
            return { result, content }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            return {
              result: { success: false, error: msg },
              content: [{ type: "text", text: msg }],
            }
          }
        }

        return {
          result: { success: false, error: `Unknown tool: ${call.name}` },
          content: [{ type: "text" as const, text: `Unknown tool: ${call.name}` }],
        }
      },
    }
  }

  /** 按模型过滤 + 权限过滤一次完成 */
  materializeWithModel(
    tools: Map<string, ToolDef>,
    effectDefs: Map<string, ToolEffect.Def>,
    modelFilter: ModelFilter,
    permissions?: PermissionSet,
  ): Materialization {
    const filtered = this.filterByModel(tools, modelFilter)
    const allDefs: ToolDef[] = [
      ...filtered,
      ...Array.from(effectDefs.values()).map((et) => ToolEffect.toLegacyToolDef(et) as unknown as ToolDef),
    ]
    const allowed = permissions
      ? allDefs.filter((t) => permissions.isAllowed(t.name, t.permission))
      : allDefs

    const toolSet: LLMToolSet = {}
    for (const t of allowed) {
      toolSet[t.name] = this.toAISDKTool(t)
    }

    return {
      definitions: toolSet,
      settle: async (call, ctx) => {
        const m = this.materialize(tools, effectDefs, permissions)
        return m.settle(call, ctx)
      },
    }
  }
}
