/**
 * @deprecated 插件钩子系统已迁移到 Cordis events（统一事件面）。
 *
 * 本模块仅作遗留插件 hook 的薄包装：
 *   - 注册（on）经『遗留名 → dsh 事件名』映射 + handler 签名适配，转发到绑定的
 *     Cordis ctx.events（pluginHooks.bindCtx(ctx)，由 createMiraContext 装配）。
 *   - 触发方法（emit/emitAsync/emitSerial/triggerUntil/emitWaterfall）仅作兜底，
 *     Agent 循环已改为直接分发 dsh 命名事件，不再经本层。
 *
 * 新的扩展点请直接使用 ctx.on / ctx.emit / ctx.waterfall 等类型化事件。
 */

import type { Context } from "../vendor/cordis/index"

// 返回值 `undefined` 表示"继续"，`非 undefined` 表示"阻断/传递"
type HookHandler = (...args: any[]) => any

/** 遗留 hook 名 → dsh 事件名映射 */
export const LEGACY_HOOK_MAP: Record<string, string> = {
  pre_llm: "agent/request",
  pre_tool_use: "tools/guard",
  pre_tool_execute: "tools/pre-execute",
  post_tool_use: "tools/post-execute",
  stop: "agent/turn-stopping",
  session_start: "session/start",
  session_end: "session/end",
  graph_maintenance: "graph/maintenance",
  user_prompt_submit: "session/prompt-submit",
}

/** 遗留 hook 名 → dsh 事件名（无映射则原样返回） */
export function mapLegacyHookName(name: string): string {
  return LEGACY_HOOK_MAP[name] ?? name
}

/**
 * 将遗留 hook handler 适配为新事件的 listener 签名（语义等价）：
 *   - pre_llm (messages, config)     → agent/request (request, next)，mutate request.messages 后 next()
 *   - pre_tool_use (call, ctx)       → tools/guard (call, ctx)，转 OpenAI 风格 {id, function}
 *   - pre_tool_execute (tc, input)   → tools/pre-execute (call, next)，mutate call 后 next()
 *   - post_tool_use (calls[], map)   → tools/post-execute (exec, result, next)，打包单条后 next()
 *   - stop (messages, config)        → agent/turn-stopping (payload)
 *   - 其余（session_* / graph_* / user_prompt_submit）载荷一致，原样透传
 */
// 遗留兼容层：事件载荷为跨系统 duck-type 桥接，统一以 any 处理（刻意为之）
/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any, @typescript-eslint/require-await */
export function adaptLegacyHook(name: string, handler: HookHandler): HookHandler {
  switch (name) {
    case "pre_llm":
      return async (request: any, next: any) => {
        const result = await handler(request.messages, request.config)
        if (result) request.messages = result
        return next()
      }
    case "pre_tool_use":
      // serial 分发（bail 不 await async handler）：返回非空即阻断
      return async (call: any, context: any) => {
        const result = await handler(
          { id: call.id, function: { name: call.name, arguments: call.arguments } },
          context,
        )
        return result === undefined ? null : result
      }
    case "pre_tool_execute":
      return async (call: any, next: any) => {
        const result = await handler(call, undefined)
        if (result) {
          call.name = result.name ?? call.name
          call.arguments = result.arguments ?? call.arguments
        }
        return next()
      }
    case "post_tool_use":
      return async (exec: any, result: any, next: any) => {
        await handler([exec], new Map([[exec.id, result]]))
        return next()
      }
    case "stop":
      return async (payload: any) => handler(payload.messages, payload.config)
    default:
      return handler
  }
}

export class PluginHooks {
  private hooks = new Map<string, Set<HookHandler>>()
  private ctx: Context | null = null

  /** 绑定全局 Cordis ctx：绑定后注册经『遗留名 → dsh 名』映射转发到 ctx.events */
  bindCtx(ctx: Context | null): void {
    this.ctx = ctx
  }

  /** 注册钩子监听（绑定 ctx 时转发到 dsh 命名事件） */
  on(event: string, handler: HookHandler): () => void {
    if (this.ctx) {
      const name = mapLegacyHookName(event)
      return this.ctx.on(name as never, adaptLegacyHook(event, handler) as never)
    }
    if (!this.hooks.has(event)) this.hooks.set(event, new Set())
    this.hooks.get(event)!.add(handler)
    return () => this.hooks.get(event)?.delete(handler)
  }

  /** 触发同步钩子 */
  emit(event: string, ...args: unknown[]): void {
    if (this.ctx) {
      const emit = this.ctx as unknown as { emit(name: string, ...args: unknown[]): void }
      emit.emit(mapLegacyHookName(event), ...args)
      return
    }
    this.hooks.get(event)?.forEach((handler) => {
      try { handler(...args) } catch { /* 单个钩子失败不影响其他 */ }
    })
  }

  /** 触发异步钩子（并行） */
  async emitAsync(event: string, ...args: unknown[]): Promise<void> {
    if (this.ctx) {
      await (this.ctx as unknown as { parallel(name: string, ...args: unknown[]): Promise<void> }).parallel(mapLegacyHookName(event), ...args)
      return
    }
    const handlers = this.hooks.get(event)
    if (!handlers) return
    await Promise.all(
      Array.from(handlers).map((h) => {
        try { return Promise.resolve(h(...args)) } catch { return Promise.resolve() }
      })
    )
  }

  /** 触发串行异步钩子（按注册顺序） */
  async emitSerial(event: string, ...args: unknown[]): Promise<void> {
    if (this.ctx) {
      await (this.ctx as unknown as { serial(name: string, ...args: unknown[]): Promise<unknown> }).serial(mapLegacyHookName(event), ...args)
      return
    }
    const handlers = this.hooks.get(event)
    if (!handlers) return
    for (const handler of handlers) {
      try { await handler(...args) } catch { /* 单个失败不影响后续 */ }
    }
  }

  /** 触发串行钩子直到有一个返回非 null（阻断模式，如 PreToolUse 权限） */
  async triggerUntil(event: string, ...args: unknown[]): Promise<any> {
    if (this.ctx) {
      const result = await (this.ctx as unknown as { serial(name: string, ...args: unknown[]): Promise<unknown> }).serial(mapLegacyHookName(event), ...args)
      return result ?? null
    }
    const handlers = this.hooks.get(event)
    if (!handlers) return null
    for (const handler of handlers) {
      try {
        const result = await handler(...args)
        if (result !== null && result !== undefined) return result
      } catch { /* 单个失败不影响后续 */ }
    }
    return null
  }

  /** 触发流水线钩子（waterfall），每个 handler 可以修改并传递值给下一个 */
  async emitWaterfall(event: string, initial: any, ...args: unknown[]): Promise<any> {
    if (this.ctx) {
      return await (this.ctx as unknown as { waterfall(name: string, ...args: unknown[]): unknown }).waterfall(
        mapLegacyHookName(event),
        ...args,
        () => initial,
      )
    }
    let result = initial
    const handlers = this.hooks.get(event)
    if (!handlers) return result
    for (const handler of handlers) {
      try {
        const r = await handler(result, ...args)
        if (r !== undefined) result = r
      } catch { /* 单个失败不影响后续 */ }
    }
    return result
  }

  /** 移除所有钩子（仅未绑定 ctx 的兜底注册表；绑定 ctx 后请经 effect/disposer 卸载） */
  clear(): void {
    this.hooks.clear()
  }

  /** 列出所有注册的事件（兜底注册表） */
  listEvents(): string[] {
    return Array.from(this.hooks.keys())
  }

  /** 获取某事件的监听器数量（绑定 ctx 时读取 ctx.events 监听表） */
  listenerCount(event: string): number {
    if (this.ctx) {
      const name = mapLegacyHookName(event)
      const table = (this.ctx.events as unknown as { _hooks?: Record<string, unknown[]> })._hooks
      return table?.[name]?.length ?? 0
    }
    return this.hooks.get(event)?.size || 0
  }
}

/** 全局单例（createMiraContext 装配时经 bindCtx 绑定到根 ctx） */
export const pluginHooks = new PluginHooks()
