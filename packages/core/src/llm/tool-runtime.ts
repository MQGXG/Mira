import type { ToolDef, ToolCall } from "../shared/tool"
import { zodToJsonSchema } from "../shared/zod-converter"

export interface ToolRuntimeConfig {
  tools: ToolDef[]
  onToolCall?: (toolCall: ToolCall) => void
}

export class ToolRuntime {
  private tools: ToolDef[]

  constructor(config: ToolRuntimeConfig) {
    this.tools = config.tools
  }

  toLLMTools(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ? extractJsonSchema(t.inputSchema) : { type: "object", properties: {} },
    }))
  }

  async execute(toolCall: ToolCall, ctx: import("../shared/tool").ToolContext): Promise<import("../shared/tool").ToolResult> {
    const tool = this.tools.find((t) => t.name === toolCall.name)
    if (!tool) {
      return { success: false, error: `Unknown tool: ${toolCall.name}` }
    }
    try {
      const input = toolCall.input || {}
      return await tool.execute(input, ctx)
    } catch (err: any) {
      return { success: false, error: err.message || String(err) }
    }
  }
}

function extractJsonSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema === "object" && schema !== null && (schema as { _def?: { typeName?: string } })._def?.typeName) {
    return zodToJsonSchema(schema)
  }
  return schema as Record<string, unknown>
}
