/**
 * Mira 事件类型定义 — 通过 declare module 合并扩展 Cordis Events
 *
 * 对齐 dsh 的类型化 merge-extensible 事件表：每个事件声明参数签名与
 * 分发模式（emit/waterfall/serial/parallel），插件监听时获得静态校验。
 */

import type { LLMMessage } from "../llm/schema/messages"
import type { ToolCall, ToolResult } from "../shared/tool"
import type { AgentConfig } from "../agent/constants"
import type { MemoryNode } from "../memory/memory-node"
import type { AgentEvent } from "../types"
import type { Agent } from "../agent/agent"
import type { AgentStatus } from "../agent/state-machine"
import type { InboxBoundary, QueueItem } from "../agent/input-queue"
import type { Fiber, FiberState } from "../vendor/cordis/fiber"
import type { Context as CordisContext, DispatchMode } from "../vendor/cordis/index"
import type { Scoped } from "../scope/index"

declare module "../vendor/cordis/context" {
  interface Events {
    // ── Cordis 内置事件（对齐 vendor events.ts 的事件表，使统一 on/emit 类型可用） ──
    /** A plugin fiber was created or its uid was cleared on disposal. */
    "internal/plugin"(fiber: Fiber): void
    /** A fiber changed lifecycle state; receives the fiber and its previous state. */
    "internal/status"(fiber: Fiber, oldValue: FiberState): void
    /** Resolve raw plugin config after the fiber's injections become active. @mode waterfall */
    "internal/config"(this: Fiber, config: any, next: () => any): any
    /** Interception hook for a service binding (no core producer). */
    "internal/service"(this: CordisContext, name: string, value: any): void
    /** Waterfall: a fiber config update is being applied; skip `next()` to veto. */
    "internal/update"(this: Fiber, config: any, noSave: boolean, next: () => void | Promise<void>): void | Promise<void>
    /** Waterfall: a service is being read through the context proxy. */
    "internal/get"(ctx: CordisContext, name: string, error: Error, next: () => any): any
    /** Waterfall: a service is being written through the context proxy. */
    "internal/set"(ctx: CordisContext, name: string, value: any, error: Error, next: () => boolean): boolean
    /** Bail: a listener is being registered; a non-null result replaces registration. */
    "internal/listener"(this: CordisContext, name: string, listener: any, prepend: boolean): void
    /** An event is being dispatched to listeners (fired for non-internal events only). */
    "internal/dispatch"(mode: DispatchMode, name: string, args: any[], thisArg: any): void

    // ── Agent 生命周期 ──────────────────────────────
    /** 回合开始前决定模型所见内容（重写/拒绝输入） @mode waterfall */
    "agent/pre-step"(
      this: unknown,
      messages: LLMMessage[],
      next: () => LLMMessage[] | Promise<LLMMessage[]>,
    ): LLMMessage[] | Promise<LLMMessage[]>
    /** 模型请求发出前拦截/改写（原 pre_llm 槽位；记忆注入在触发前内联完成） @mode waterfall */
    "agent/request"(
      this: unknown,
      request: { messages: LLMMessage[]; config: AgentConfig },
      next: () => { messages: LLMMessage[]; config: AgentConfig } | Promise<{ messages: LLMMessage[]; config: AgentConfig }>,
    ): { messages: LLMMessage[]; config: AgentConfig } | Promise<{ messages: LLMMessage[]; config: AgentConfig }>
    /** 回合停止决策（serial：返回非空即强制继续，原 stop 槽位） @mode serial */
    "agent/turn-stopping"(
      this: unknown,
      payload: { messages: LLMMessage[]; config: AgentConfig },
    ): boolean | string | void
    /**
     * 回合级收敛保护（loop-hygiene，对齐 dsh guard 插件化思路）：
     * 每个纯工具回合（有工具调用）完成后触发；监听器返回 string 作为
     * 强制总结指令（由循环注入并继续），void 放行。首个返回 string 的
     * 监听器短路（无需调用 next）。 @mode waterfall
     */
    "agent/step-end"(
      this: unknown,
      payload: { sessionID?: string; hasText: boolean; toolNames: string[] },
      next: () => void,
    ): string | void
    /** Agent 事件统一出口（Mira AgentEvent 透传） @mode emit */
    "agent/event"(event: AgentEvent): void
    /** Agent 注册（ctx.agents.announce，scope-target 广播） @mode emit */
    "agent/created"(payload: { agent: Agent }): void
    /** Agent 注销（ctx.agents detach，scope-target 广播） @mode emit */
    "agent/disposed"(payload: { agent: Agent }): void
    /** Agent 会话启动（发布后广播） @mode emit */
    "agent/session-start"(payload: { source: "startup" | "resume" }): void
    /** Agent 生命周期状态变化（idle ⇄ running） @mode emit */
    "agent/status"(
      this: Scoped<Agent>,
      payload: { agent: Agent; status: AgentStatus },
    ): void
    /** Agent 回合错误（turn-runner LLM 流错误；turn/step 由触发上下文尽力提供） @mode emit */
    "agent/error"(payload: { turn?: number; step?: number; error: string | Error }): void
    /** 模型请求错误且降级链耗尽（FallbackClient 全部 provider 失败；对齐 dsh agent/request-error） @mode emit */
    "agent/request-error"(
      payload: { turn?: number; error: string | Error; attempt: number; provider?: string },
    ): void
    /** Inbox 投递（followup/steer/inject 入队） @mode emit */
    "agent/inbox/inserted"(
      payload: { agent: Agent; boundary: InboxBoundary; item: QueueItem },
    ): void
    /** Inbox 取走（claim 消费） @mode emit */
    "agent/inbox/claimed"(
      payload: { agent: Agent; boundary: InboxBoundary; item: QueueItem },
    ): void
    /** Inbox 丢弃 @mode emit */
    "agent/inbox/discarded"(
      payload: { agent: Agent; item: QueueItem },
    ): void
    /** Inbox 变更（splice 操作流，可回放持久化） @mode emit */
    "agent/inbox/spliced"(
      payload: {
        agent: Agent
        ops: Array<{ op: "insert" | "delete"; boundary: InboxBoundary; index: number; item?: { message: string; type: string } }>
      },
    ): void
    /** 会话开始 @mode emit */
    "session/start"(payload: { sessionID?: string; workspace?: string }): void
    /** 会话结束 @mode emit */
    "session/end"(payload: { sessionID?: string; workspace?: string }): void
    /** 用户提示提交（Mira 特有，原 user_prompt_submit） @mode emit */
    "session/prompt-submit"(payload: { sessionID?: string; message: string }): void

    // ── 工具生命周期 ────────────────────────────────
    /** 工具执行前策略（重写调用） @mode waterfall */
    "tools/pre-execute"(
      this: unknown,
      call: { id: string; name: string; arguments: string },
      next: () => { id: string; name: string; arguments: string } | Promise<{ id: string; name: string; arguments: string }>,
    ): { id: string; name: string; arguments: string } | Promise<{ id: string; name: string; arguments: string }>
    /** 工具执行前单调守卫（bail：返回非空即阻断，字符串为拒绝原因；对齐 dsh tools.guard 概念，原 pre_tool_use 槽位） @mode bail */
    "tools/guard"(
      this: unknown,
      call: { id: string; name: string; arguments: string },
      context: { sessionID?: string; workspace?: string },
    ): boolean | string | void
    /** 工具执行后观察（读取/改写结果；载荷对齐 dsh tools/post-execute） @mode waterfall */
    "tools/post-execute"(
      this: unknown,
      exec: { id: string; name: string },
      result: ToolResult,
      next: () => ToolResult | Promise<ToolResult>,
    ): ToolResult | Promise<ToolResult>
    /** 工具 body 执行包裹（对齐 dsh 管线 dispatch 阶段：监听器可调用 next() 执行或自行执行；介于 pre-execute 与 post-execute 之间） @mode waterfall */
    "tools/execute"(
      this: unknown,
      exec: { id: string; name: string; args: Record<string, unknown> },
      next: () => ToolResult | Promise<ToolResult>,
    ): ToolResult | Promise<ToolResult>
    /** 工具注册（可拦截/替换） @mode waterfall */
    "tools/register"(
      this: unknown,
      tool: { name: string; description: string },
      next: () => boolean | Promise<boolean>,
    ): boolean | Promise<boolean>
    /** 工具注册表变更（全局/作用域层注册或限制变化通知） @mode emit */
    "tools/change"(): void
    /** 工具执行结果归档（只读观察） @mode emit */
    "tools/result"(
      exec: { name: string; args: Record<string, unknown> },
      result: ToolResult,
    ): void

    // ── 记忆 ────────────────────────────────────────
    /** 记忆召回 @mode emit */
    "memory/recalled"(memories: MemoryNode[]): void
    /** 记忆写入 @mode emit */
    "memory/stored"(memory: MemoryNode): void

    // ── 图谱（Mira 特有） ───────────────────────────
    /** 记忆图谱自动维护完成（低频衰减/固化，原 graph_maintenance） @mode emit */
    "graph/maintenance"(payload: { forgotten: number; consolidated: number }): void

    // ── 插件 ────────────────────────────────────────
    /** 插件加载完成 @mode emit */
    "plugin/loaded"(name: string): void
    /** 插件卸载完成 @mode emit */
    "plugin/unloaded"(name: string): void

    // ── 系统提示（systemPrompt） ─────────────────────
    /** 系统提示贡献变更（全局/作用域层注册或撤销通知） @mode emit */
    "system-prompt/change"(): void
    /** 系统提示组装（waterfall：可改写最终装配结果） @mode waterfall */
    "system-prompt/assemble"(
      this: unknown,
      assembly: { system: string; context: string },
      next: () => { system: string; context: string } | Promise<{ system: string; context: string }>,
    ): { system: string; context: string } | Promise<{ system: string; context: string }>
  }
}

// 导出事件名常量，便于字符串事件统一引用（避免魔法字符串）
export const MiraEvents = {
  AGENT_PRE_STEP: "agent/pre-step",
  AGENT_REQUEST: "agent/request",
  AGENT_TURN_STOPPING: "agent/turn-stopping",
  AGENT_STEP_END: "agent/step-end",
  AGENT_EVENT: "agent/event",
  AGENT_CREATED: "agent/created",
  AGENT_DISPOSED: "agent/disposed",
  AGENT_SESSION_START: "agent/session-start",
  AGENT_STATUS: "agent/status",
  AGENT_ERROR: "agent/error",
  AGENT_REQUEST_ERROR: "agent/request-error",
  AGENT_INBOX_INSERTED: "agent/inbox/inserted",
  AGENT_INBOX_CLAIMED: "agent/inbox/claimed",
  AGENT_INBOX_DISCARDED: "agent/inbox/discarded",
  AGENT_INBOX_SPLICED: "agent/inbox/spliced",
  SESSION_START: "session/start",
  SESSION_END: "session/end",
  SESSION_PROMPT_SUBMIT: "session/prompt-submit",
  TOOLS_PRE_EXECUTE: "tools/pre-execute",
  TOOLS_GUARD: "tools/guard",
  TOOLS_EXECUTE: "tools/execute",
  TOOLS_POST_EXECUTE: "tools/post-execute",
  TOOLS_REGISTER: "tools/register",
  TOOLS_CHANGE: "tools/change",
  TOOLS_RESULT: "tools/result",
  MEMORY_RECALLED: "memory/recalled",
  MEMORY_STORED: "memory/stored",
  GRAPH_MAINTENANCE: "graph/maintenance",
  PLUGIN_LOADED: "plugin/loaded",
  PLUGIN_UNLOADED: "plugin/unloaded",
  SYSTEM_PROMPT_CHANGE: "system-prompt/change",
  SYSTEM_PROMPT_ASSEMBLE: "system-prompt/assemble",
} as const

export type MiraEventName = keyof typeof MiraEvents
