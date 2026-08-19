/**
 * 共享的插入序存储与作用域感知注册表的效果所有权。
 *
 * 移植自 @deepseek-ai/dsh-scope。
 *
 * @module @mira/core/scope
 */

import type { Context } from "../vendor/cordis/index"
import { scopeChainOf, scopeOf } from "./index"
import type { ScopeKey } from "./index"

/** 一个作用域对注册表的聚合贡献。 */
export interface ScopeLayer {
  /** 本层所有表是否都为空。 */
  isEmpty(): boolean
}

/** 两个条目表实现的内部公共读契约。 */
interface EntryValues<V> {
  values(): IterableIterator<V>
  isEmpty(): boolean
}

/**
 * 插入序命名条目，带调用方拥有的重复名诊断。
 *
 * 值被借用。迭代器在一个非空表代内是活的；排空表使其与后续插入分离。
 * 每次成功插入返回该精确条目的幂等撤销。
 */
export class NamedEntries<V> implements EntryValues<V> {
  private data = new Map<string, V>()

  constructor(
    private readonly duplicateError: (name: string) => Error,
  ) {}

  /**
   * 插入一个唯一名称。
   * @param name - 本表内唯一的名称。
   * @param value - 保留的借用值。
   * @returns 仅移除本次插入的幂等撤销。
   */
  insert(name: string, value: V): () => void {
    const data = this.data
    if (data.has(name)) throw this.duplicateError(name)
    data.set(name, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(name)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * 读取一个命名值。
   * @param name - 待解析的名称。
   * @returns 保留的值，或缺失时的 `undefined`。
   */
  get(name: string): V | undefined {
    return this.data.get(name)
  }

  /**
   * 测试一个名称的成员资格。
   * @param name - 待测试的名称。
   * @returns 本表是否包含该名称。
   */
  has(name: string): boolean {
    return this.data.has(name)
  }

  /**
   * 按插入序迭代活跃名称。
   * @returns 原生活跃键迭代器。
   */
  keys(): IterableIterator<string> {
    return this.data.keys()
  }

  /**
   * 按插入序迭代活跃条目。
   * @returns 原生活跃条目迭代器。
   */
  entries(): IterableIterator<[string, V]> {
    return this.data.entries()
  }

  /**
   * 按插入序迭代活跃值。
   * @returns 原生活跃值迭代器。
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * 测试本表是否无条目。
   * @returns 表是否为空。
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * 插入序匿名条目，带独立注册身份。
 *
 * 相等的值仍是独立注册。值被借用，迭代器在一个非空表代内是活的；
 * 排空表使其与后续追加分离。
 */
export class AnonymousEntries<V> implements EntryValues<V> {
  private data = new Map<symbol, V>()

  /**
   * 追加一个独立拥有的值。
   * @param value - 保留的借用值。
   * @returns 本次精确追加的幂等撤销。
   */
  append(value: V): () => void {
    const data = this.data
    const key = Symbol()
    data.set(key, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(key)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * 按插入序迭代活跃值。
   * @returns 原生活跃值迭代器。
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * 测试本表是否无条目。
   * @returns 表是否为空。
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

/**
 * 为一个注册表拥有全局层与精确作用域层。
 *
 * 读取从不创建作用域层。注册同时从提供的 Cordis 上下文推导可见性与效果
 * 所有权，在通知前收集撤销，且仅回收完全空的聚合层。
 */
export class ScopedLayers<L extends ScopeLayer> {
  /** 急切构造的上下文全局层。 */
  readonly global: L

  private readonly scoped = new Map<ScopeKey, L>()

  constructor(
    private readonly createLayer: (scope: ScopeKey | undefined) => L,
    private readonly onChange: () => void,
  ) {
    this.global = createLayer(undefined)
  }

  /**
   * 读取现有精确作用域覆盖。刻意链盲：寻址一个作用域自身贡献（其限制、
   * 其守卫）的调用方不得静默拾取祖先的 —— 需要继承时用 {@link chainLayers}。
   * @param scope - 精确作用域键；`undefined` 表示无覆盖。
   * @returns 现有作用域层，或未创建的 `undefined`。
   */
  peek(scope: ScopeKey | undefined): L | undefined {
    if (scope === undefined) return undefined
    return this.scoped.get(scope)
  }

  /**
   * 沿作用域父链的现有覆盖（{@link scopeChainOf}），最远祖先在前、精确
   * 作用域最后，调用方按序分层时最近的覆盖有最终决定权。
   * @param scope - 查看作用域，或无覆盖的 `undefined`。
   * @returns 现有层，最近在后；缺失覆盖跳过。
   */
  chainLayers(scope: ScopeKey | undefined): L[] {
    const layers: L[] = []
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }

  /**
   * 物化全局命名条目后跟作用域链覆盖，最远祖先在前，最近作用域的条目赢得名称。
   * @param scope - 查看作用域，或全局视图的 `undefined`。
   * @param pick - 从层中选择命名表。
   * @returns 插入序有效映射。
   */
  merge<V>(
    scope: ScopeKey | undefined,
    pick: (layer: L) => NamedEntries<V>,
  ): Map<string, V> {
    const merged = new Map(pick(this.global).entries())
    for (const layer of this.chainLayers(scope)) {
      for (const [name, value] of pick(layer).entries()) merged.set(name, value)
    }
    return merged
  }

  /**
   * 将一个同步层变更附加到其注册上下文。
   * @param ctx - 决定作用域可见性与效果所有权的上下文。
   * @param action - 返回其同步撤销的原子变更。
   * @param options - Cordis effect 标签与可选变更通知。
   * @returns ctx.effect() 返回的精确 disposer。
   */
  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void {
    const scope = scopeOf(ctx)
    const notify = options.notify ?? true
    const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
      let layer: L
      let created = false
      if (scope === undefined) {
        layer = this.global
      } else {
        const existing = this.scoped.get(scope)
        if (existing === undefined) {
          layer = this.createLayer(scope)
          this.scoped.set(scope, layer)
          created = true
        } else {
          layer = existing
        }
      }

      let undo: () => void
      try {
        undo = action(layer)
      } catch (error) {
        if (scope !== undefined && created && layer.isEmpty()) this.scoped.delete(scope)
        throw error
      }

      yield () => {
        undo()
        if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
        if (notify) this.onChange()
      }
      if (notify) this.onChange()
    }.bind(this), options.label)
    // 精确同步 disposer 保留 Cordis effect 身份
    return dispose
  }
}
