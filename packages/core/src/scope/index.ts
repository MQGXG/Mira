/**
 * 作用域上下文原语 — 移植自 @deepseek-ai/dsh-scope
 *
 * 铸造一个 Cordis 上下文，用不透明身份标记注册，并为该身份构建
 * 仅路由的事件载体（scopeTarget）。Mira 对齐 dsh 的统一作用域原语。
 *
 * @module @mira/core/scope
 */

import type { Context, Fiber } from "../vendor/cordis/index"
import { Context as CordisContext } from "../vendor/cordis/index"

export { AnonymousEntries, NamedEntries, ScopedLayers } from "./store"
export type { ScopeLayer } from "./store"

/** 不透明、按身份比较的作用域键。 */
export type ScopeKey = object

/** createScope 写入的上下文标签。 */
const kScope = Symbol("mira.scope")

declare const ScopedBrand: unique symbol

/**
 * scopeTarget 构建的仅路由事件接收器。类型参数记录主题类型用于
 * 分发检查；载体不暴露主题的属性。事件载荷携带真实主题。
 */
export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }

/** 每个载体关联的键。存在即区分无键载体与非载体。 */
const carrierKeys = new WeakMap<object, ScopeKey | undefined>()

/**
 * 每个键的包围作用域。一个关系驱动作用域嵌套的双向：
 * 注册视图沿链向下继承（子作用域看到祖先的层 — ScopedLayers），
 * 事件准入沿链向上延伸（标记祖先的监听器接收派发到后代键的事件 — scopeTarget）。
 */
const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

/** 重定向一个作用域键父链接的特权句柄。 */
export interface ScopeParentBinding {
  /**
   * 将绑定键重新链接到不同父作用域，与 bind 相同的环检查。
   * 仅在旧父作用域下产生的任何内容未被保留时有效 —— 空白会话重组契约。
   * @param parent - 新的包围作用域键。
   */
  rebind(parent: ScopeKey): void
}

/** bind 与每次 rebind 共享的环检查写入。 */
function linkScopeParent(key: ScopeKey, parent: ScopeKey): void {
  for (let cursor: ScopeKey | undefined = parent; cursor !== undefined; cursor = scopeParents.get(cursor)) {
    if (cursor === key) throw new Error("mira-scope: scope parent link would form a cycle")
  }
  scopeParents.set(key, parent)
}

/**
 * 将 `parent` 绑定为 `key` 的包围作用域，仅一次。
 *
 * 已有父作用域的键抛错：没有开放的重链接路径，只有原始绑定者（唯一收到
 * {@link ScopeParentBinding} 的一方）能移动作用域的祖先。会形成环的链接被拒绝。
 * @param key - 子作用域键。
 * @param parent - 其包围作用域键。
 * @returns 唯一可重链接此键的绑定。
 */
export function bindScopeParent(key: ScopeKey, parent: ScopeKey): ScopeParentBinding {
  if (scopeParents.has(key)) {
    throw new Error("mira-scope: scope key is already bound to a parent; re-linking requires the binding returned by the original bind")
  }
  linkScopeParent(key, parent)
  return {
    rebind(next: ScopeKey): void {
      linkScopeParent(key, next)
    },
  }
}

/**
 * 读取一个键的包围作用域。
 * @param key - 待检查的作用域键。
 * @returns 其父键，或根作用域的 `undefined`。
 */
export function scopeParentOf(key: ScopeKey): ScopeKey | undefined {
  return scopeParents.get(key)
}

/**
 * 从一个键到其根祖先的链。
 * @param key - 起始键，或空链的 `undefined`。
 * @returns 近端在前：`[key, parent, grandparent, …]`。
 */
export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = []
  for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor)
  return chain
}

/** 铸造的注册作用域及其静止释放边界。 */
export interface Scope {
  /** 经此上下文做出作用域拥有的注册。 */
  ctx: Context
  /** 精确 Cordis disposer，用于在有序复合 effect 中嵌套此作用域。 */
  rawDispose: () => Promise<void> | void
  /** 释放每个作用域拥有的注册；竞态调用 await 同一完成。 */
  dispose(): Promise<void>
}

/** 即使原始 disposer 已被认领，也跟随 Cordis fiber 完成异步拆除。 */
async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

/** 用作作用域支撑 fiber 的共享 no-op 插件。 */
function scope(): void {}

/** createScope 接受的选项。 */
export interface CreateScopeOptions {
  /** 通过 bindScopeParent 绑定的包围作用域；绑定保持内部。 */
  parent?: ScopeKey
}

/**
 * 在 `ctx` 下铸造一个作用域。作用域上下文继承铸造插件的依赖 API，
 * 拥有经它做出的每个注册。
 * @param ctx - 作用域继承其依赖 API 的活动上下文。
 * @param key - 用于监听器路由的不透明身份。
 * @param options - 可选的作用域链放置。
 * @returns 作用域上下文及精确/共享释放边界。
 */
export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope {
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  const fiber = ctx.plugin(scope)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    dispose: () => (disposing ??= quiesceFiber(fiber)),
  }
}

/**
 * 读取上下文继承的最近作用域标签。
 * @param ctx - 待检查的上下文。
 * @returns 其作用域键，或无作用域上下文的 `undefined`。
 */
export function scopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [kScope]?: ScopeKey })[kScope]
}

/**
 * 构建保留基础过滤器、全局接受未标记监听器、并接受匹配键或其任一祖先
 * 的标记监听器的不透明接收器：包围作用域拥有的监听器接收其下每个后代
 * 作用域的事件 —— 这正是单个常驻组合观察其下组成的每个 agent 的方式。
 * 低于派发键的标签保持排除 —— 事件沿链向上流动，从不向下。
 * @param base - 保留其现有 Cordis 过滤器的主体或服务。
 * @param key - 路由作用域身份，或无作用域主体的 `undefined`。
 * @returns 载体，其主体仅经事件参数可得。
 */
export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter = (base as { [CordisContext.filter]?: (ctx: Context) => boolean })[CordisContext.filter]
  const carrier = {
    [CordisContext.filter](ctx: Context): boolean {
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false
      const tag = scopeOf(ctx)
      if (tag === undefined) return true
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
    },
  }
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}

/**
 * 测试一个值是否为作用域载体。
 * @param value - 待检查的分发接收器。
 * @returns 是否由 scopeTarget 创建。
 */
export function isScopeCarrier(value: unknown): value is Scoped<object> {
  return typeof value === "object" && value !== null && carrierKeys.has(value)
}

/**
 * 读取载体的路由键。
 * @param value - 待检查的分发接收器。
 * @returns 载体键，或无键/非载体值的 `undefined`。
 */
export function carrierKeyOf(value: unknown): ScopeKey | undefined {
  if (!isScopeCarrier(value)) return undefined
  return carrierKeys.get(value)
}
