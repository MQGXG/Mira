import type { ToolContext, ToolResult } from "./tool"
import type { ToolRegistry } from "../system/registry"
import { logToolCall } from "../system/logger"

export interface ExecutorResult {
  results: Map<string, ToolResult>
  toolResults: Array<{
    call: { id: string; function: { name: string; arguments: string } }
    result: ToolResult
  }>
}

export async function executeToolCalls(
  approvedCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  registry: ToolRegistry,
  ctx: ToolContext,
  logMeta?: { provider?: string; model?: string },
): Promise<ExecutorResult> {
  const results = new Map<string, ToolResult>()
  let toolResults: Array<{
    call: { id: string; function: { name: string; arguments: string } }
    result: ToolResult
  }> = []

  try {
    toolResults = await Promise.all(
      approvedCalls.map(async (call) => {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.function.arguments) } catch { /* LLM 可能返回非法 JSON，用空对象 */ }
        const startTime = Date.now()
        const result = await registry.execute(call.function.name, args, ctx)
        try {
          logToolCall({
            timestamp: new Date().toISOString(),
            toolName: call.function.name,
            args,
            result,
            durationMs: Date.now() - startTime,
            provider: logMeta?.provider,
            model: logMeta?.model,
          })
        } catch {}
        return { call, result }
      }),
    )
  } catch (e) {
    for (const call of approvedCalls) {
      if (!results.has(call.id)) {
        results.set(call.id, {
          success: false,
          error: `工具执行异常: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    }
  }

  for (const { call, result } of toolResults) {
    results.set(call.id, result)
  }

  return { results, toolResults }
}
