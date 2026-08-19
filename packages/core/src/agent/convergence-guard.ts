/**
 * 回合级收敛保护（loop-hygiene）— 对齐 dsh guard 包插件化思路
 *
 * 默认注册于 createMiraContext（registerConvergenceGuard）。
 * 监听 agent/step-end：连续纯工具回合（无文本）达到阈值时返回强制总结指令
 * （搜索类工具 4 回合 / 其他 8 回合），由 Agent 循环注入消息并强制总结。
 * 计数按 sessionID 隔离（Map），返回指令后删除计数（等效原 consecutiveToolTurns 重置语义）。
 * 卸载时随 ctx 生命周期回滚（ctx.on 返回 disposer）。
 */

import type { Context } from "../vendor/cordis/index"

/** 搜索类工具（原 stages.ts 判定集） */
const SEARCH_TOOLS = ["web_search", "web_fetch", "web_browse", "web_fetch_url"] as const

/** 非搜索纯工具回合上限（原 MAX_PURE_TOOL_TURNS） */
const MAX_PURE_TOOL_TURNS = 8

/** 搜索类纯工具回合上限（原 isSearchTurn ? 4 : 8） */
const MAX_PURE_SEARCH_TURNS = 4

/** 强制总结指令（原 stages.ts 注入文本） */
const FORCE_SUMMARY_PROMPT =
  "你已经连续调用工具多次但尚未给出文字回复。请立即基于已有信息总结回答，不要再调用任何工具。"

/**
 * 注册回合级收敛保护守卫（Cordis 插件式，可逆卸载）。
 * @param ctx 根 Context（根 ctx 未标记监听，接收所有作用域事件）。
 * @returns 卸载 disposer（调用后守卫停止拦截）。
 */
export function registerConvergenceGuard(ctx: Context): () => void {
  const counters = new Map<string, number>()
  return ctx.on(
    "agent/step-end",
    ({ sessionID, hasText, toolNames }: { sessionID?: string; hasText: boolean; toolNames: string[] }) => {
      if (sessionID === undefined) return undefined
      if (!hasText) {
        const next = (counters.get(sessionID) ?? 0) + 1
        const max = toolNames.some((n) => (SEARCH_TOOLS as readonly string[]).includes(n))
          ? MAX_PURE_SEARCH_TURNS
          : MAX_PURE_TOOL_TURNS
        if (next >= max) {
          counters.delete(sessionID)
          return FORCE_SUMMARY_PROMPT
        }
        counters.set(sessionID, next)
      } else {
        counters.delete(sessionID)
      }
      return undefined
    },
  )
}