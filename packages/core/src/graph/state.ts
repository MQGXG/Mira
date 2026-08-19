/**
 * StateStore — 图共享状态管理
 * 核心职责：
 * 1. 按 Schema 校验字段类型
 * 2. 执行节点 writes 白名单（防 State 污染）
 * 3. 三种更新策略：replace / append / reducer
 */

import type { GraphState, GraphStateSchema, StateUpdateStrategy } from "./types"

export class StateStore<S extends GraphState = GraphState> {
  private state: S
  private schema: GraphStateSchema
  private reducers: Record<string, (current: unknown, incoming: unknown) => unknown> = {}

  constructor(initialState: S = {} as S, schema: GraphStateSchema = {}) {
    this.state = { ...initialState }
    this.schema = schema
  }

  /** 注册 reducer 合并函数 */
  registerReducer(name: string, fn: (current: unknown, incoming: unknown) => unknown): void {
    this.reducers[name] = fn
  }

  /** 读取快照（只读视图） */
  get(): Readonly<S> {
    return { ...this.state }
  }

  /** 深拷贝快照（并行分支隔离用：各分支基于独立副本执行） */
  snapshot(): S {
    return structuredClone(this.state)
  }

  /** 合并补丁并返回合并后的完整状态（并行分支汇聚用） */
  mergePatch(patch: Partial<S>): Readonly<S> {
    this.merge(patch)
    return this.get()
  }

  /** 校验字段类型（契约校验用，返回是否合法而非抛错） */
  checkField(key: string, value: unknown): boolean {
    const fieldSchema = this.schema[key]
    if (!fieldSchema) return true
    if (value === undefined || value === null) return true
    return this.isTypeValid(value, fieldSchema.type)
  }

  getField<K extends keyof S>(key: K): S[K] {
    return this.state[key]
  }

  /** 节点写入：校验白名单 + Schema 类型 + 更新策略 */
  write(patch: Partial<S>, allowedWrites?: (keyof S)[]): void {
    for (const [key, value] of Object.entries(patch)) {
      const k = key as keyof S
      // 白名单校验 — 越权写入拒绝
      if (allowedWrites && !allowedWrites.includes(k)) {
        throw new Error(`[StateStore] Node tried to write forbidden field "${String(k)}"`)
      }
      this.applyField(k, value)
    }
  }

  /** 合并状态（允许写入保留字段，用于运行时内部字段） */
  merge(patch: Partial<S>): void {
    for (const [key, value] of Object.entries(patch)) {
      this.applyField(key, value)
    }
  }

  private applyField(key: keyof S, value: unknown): void {
    const fieldSchema = this.schema[String(key)]
    if (fieldSchema) {
      this.validateType(String(key), value, fieldSchema.type)
      const strategy: StateUpdateStrategy = fieldSchema.update || "replace"
      if (strategy === "append" && Array.isArray(this.state[key])) {
        const current = this.state[key] as unknown[]
        const incoming = Array.isArray(value) ? (value as unknown[]) : [value]
        this.state[key] = [...current, ...incoming] as S[keyof S]
        return
      }      if (strategy === "reducer") {
        if (fieldSchema.reducer && this.reducers[fieldSchema.reducer]) {
          this.state[key] = this.reducers[fieldSchema.reducer](this.state[key], value) as S[keyof S]
          return
        }
        // 无 reducer 时回退 replace
      }
    }
    this.state[key] = value as S[keyof S]
  }

  private validateType(key: string, value: unknown, type: string): void {
    if (value === undefined || value === null) return
    if (!this.isTypeValid(value, type)) {
      throw new Error(`[StateStore] Field "${key}" expected ${type}, got ${typeof value}`)
    }
  }

  private isTypeValid(value: unknown, type: string): boolean {
    let ok = false
    switch (type) {
      case "string": ok = typeof value === "string"; break
      case "number": ok = typeof value === "number"; break
      case "boolean": ok = typeof value === "boolean"; break
      case "array": ok = Array.isArray(value); break
      case "object": ok = typeof value === "object" && !Array.isArray(value); break
    }
    return ok
  }

  toJSON(): S {
    return { ...this.state }
  }

  static fromJSON<S extends GraphState>(json: S): StateStore<S> {
    const store = new StateStore<S>(json)
    return store
  }
}
