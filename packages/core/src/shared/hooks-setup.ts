/**
 * 默认钩子注册 — 为 PluginHooks 注册审计日志等基础行为
 *
 * 事件名规范（与 s04 参考对齐）：
 *   - pre_llm:      LLM 调用前，可修改 messages（waterfall）
 *   - pre_tool_use:  工具执行前，返回非 null 即阻止（triggerUntil）
 *   - post_tool_use: 工具执行后，仅通知（emitAsync）
 *   - stop:          Agent 停止前，返回字符串则强制继续（triggerUntil）
 */

import { pluginHooks } from "./plugin-hooks"

let hooksInitialized = false

/** 注册默认钩子（日志记录、审计） */
export function setupDefaultHooks(): void {
  if (hooksInitialized) return
  hooksInitialized = true

  // PreToolUse: 记录即将执行的工具
  pluginHooks.on("pre_tool_use", (toolCall: any, _config: any) => {
    console.log(`[Hook] PreToolUse: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 100)})`)
    return null // 不阻止
  })

  // PostToolUse: 记录工具调用结果摘要
  pluginHooks.on("post_tool_use", (_calls: any[], results: Map<string, any>) => {
    for (const [id, result] of results) {
      const status = result.success ? "ok" : "fail"
      console.log(`[Hook] PostToolUse: ${id} → ${status}`)
    }
  })

  // Stop: 打印会话摘要
  pluginHooks.on("stop", (messages: any[], _config: any) => {
    const userCount = messages.filter((m: any) => m.role === "user").length
    const toolCount = messages.filter((m: any) => m.role === "tool").length
    console.log(`[Hook] Stop: ${userCount} user turns, ${toolCount} tool results`)
    return null // 不阻止停止
  })
}

/** 检查钩子是否已初始化 */
export function isHooksInitialized(): boolean {
  return hooksInitialized
}
