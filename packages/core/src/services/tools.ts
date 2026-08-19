/**
 * 工具服务 — ctx.tools
 * 对齐 dsh ctx.tools（ToolRuntime）接口面：
 * register 返回 disposer、restrict/guard 作用域化、ScopedLayers 分层、执行管线事件。
 * 保留 Mira ToolDef 领域模型（48 工具 + MCP/Plugin 注册面经 ToolRegistry 承载）。
 */

import { Service } from "../vendor/cordis/index"
import type { Context } from "../vendor/cordis/index"
import { ToolRegistry } from "../system/registry"
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf } from "../scope/index"
import type { ScopeKey } from "../scope/index"
import type { ModelFilter } from "../system/registry"
import { getModeToolAllowlist } from "../config/modes"
import type { PermissionSet } from "../system/permission"
import type { ToolService, ToolGuard, ToolRestriction } from "../framework/context"
import type {
  ToolDef, ToolContext, ToolResult,
  ToolExecutionInput, ToolExecutionResult,
} from "../shared/tool"
import { settle, toolAbortedBeforeDispatchResult, toolAbortedResult, toolErrorResult } from "../shared/tool"

/** 单作用域对工具注册表的聚合贡献（对齐 dsh ToolLayer 语义） */
interface ToolLayer {
  /** 命名工具表（本层内重名抛错，跨层由 merge 语义决定覆盖） */
  tools: NamedEntries<ToolDef>
  /** 匿名守卫表（每个守卫独立注册身份） */
  guards: AnonymousEntries<ToolGuard>
  /** 匿名限制表（作用域级 allow/deny 过滤） */
  restrictions: AnonymousEntries<ToolRestriction>
  isEmpty(): boolean
}

/** 铸造一个空工具层 */
function createToolLayer(): ToolLayer {
  const layer: ToolLayer = {
    tools: new NamedEntries<ToolDef>((name) => new Error(`tool "${name}" is already registered in this scope`)),
    guards: new AnonymousEntries<ToolGuard>(),
    restrictions: new AnonymousEntries<ToolRestriction>(),
    isEmpty() {
      return this.tools.isEmpty() && this.guards.isEmpty() && this.restrictions.isEmpty()
    },
  }
  return layer
}

/** 工具服务插件配置 */
export interface MiraToolServiceConfig {
  /** 注入共享 ToolRegistry（sidecar 链路复用 createDefaultRegistry，让工具单一寻址） */
  registry?: ToolRegistry
  /** 注入共享 ScopedLayers（作用域实例复用根实例的层，作用域注册写入该层） */
  layers?: ScopedLayers<ToolLayer>
}

export class MiraToolService extends Service implements ToolService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "tools"
  /** 底层 ToolRegistry（供 mcp/plugin 生命周期装配） */
  readonly registry: ToolRegistry
  /** 全局 + 作用域层存储（root 实例创建，作用域实例共享注入） */
  readonly layers: ScopedLayers<ToolLayer>

  constructor(ctx: import("../vendor/cordis/index").Context, config: MiraToolServiceConfig = {}) {
    super(ctx, "tools")
    this.registry = config.registry ?? new ToolRegistry()
    this.layers = config.layers
      ?? new ScopedLayers<ToolLayer>(
        () => createToolLayer(),
        () => { this.ctx.emit("tools/change") },
      )
  }

  /**
   * 注册工具（对齐 dsh：返回精确 disposer）。
   * 在作用域 ctx（agent.ctx 上装配的服务实例）下注册写入作用域层，否则写入全局 registry。
   */
  register(tool: ToolDef): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      this.registry.register(tool)
      return () => { this.registry.unregister(tool.name) }
    }
    return this.layers.effect(this.ctx, (layer) => layer.tools.insert(tool.name, tool), { label: "tools.register()" })
  }

  /** 可逆注册：等价 register（dsh 形态已内置 disposer，保留命名兼容） */
  registerEffectively(tool: ToolDef): () => void {
    return this.register(tool)
  }

  unregister(name: string): boolean {
    return this.registry.unregister(name)
  }

  get(name: string): ToolDef | undefined {
    return this.registry.get(name)
  }

  getAll(): ToolDef[] {
    return this.registry.getAll()
  }

  /**
   * 作用域限制（对齐 dsh tools.restrict）：仅作用域 ctx 下可用，
   * allow/deny 只影响该作用域（agent）的工具视图，返回 disposer。
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead")
    }
    if (!filter.allow?.length && !filter.deny?.length) {
      throw new Error("tools.restrict() is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)")
    }
    return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(filter), { label: "tools.restrict()" })
  }

  /**
   * 单调守卫（对齐 dsh tools.guard）：每个守卫在工具执行前评估，
   * 返回 string 表示拒绝原因，void 放行。返回 disposer。
   */
  guard(guard: ToolGuard): () => void {
    return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), { label: "tools.guard()", notify: false })
  }

  /** 全局 registry 与作用域链层合并解析（对齐 dsh ScopedLayers.merge：最近作用域覆盖全局） */
  resolve(scopeKey: ScopeKey | undefined): Map<string, ToolDef> {
    const merged = new Map<string, ToolDef>()
    for (const def of this.registry.getAll()) merged.set(def.name, def)
    for (const layer of this.layers.chainLayers(scopeKey)) {
      for (const [name, def] of layer.tools.entries()) merged.set(name, def)
    }
    return merged
  }

  /** 按作用域链应用 restrict 后的解析（deny 优先删除；allow 非空则白名单收敛） */
  resolveWithRestrictions(scopeKey: ScopeKey | undefined): Map<string, ToolDef> {
    const merged = this.resolve(scopeKey)
    let allow: Set<string> | null = null
    for (const layer of this.layers.chainLayers(scopeKey)) {
      for (const restriction of layer.restrictions.values()) {
        if (restriction.deny) {
          for (const name of restriction.deny) merged.delete(name)
        }
        if (restriction.allow) {
          if (allow === null) allow = new Set()
          for (const name of restriction.allow) allow.add(name)
        }
      }
    }
    if (allow !== null) {
      for (const name of [...merged.keys()]) {
        if (!allow.has(name)) merged.delete(name)
      }
    }
    return merged
  }

  /** 全局工具 + 作用域注册 + restrict 过滤（供 agent 作用域物化） */
  resolveForScope(ctx: Context): Map<string, ToolDef> {
    return this.resolveWithRestrictions(scopeOf(ctx))
  }

  materialize(permissions?: PermissionSet): { definitions: Record<string, unknown> } {
    const m = this.registry.materialize(permissions)
    return { definitions: m.definitions }
  }

  /**
   * 作用域物化 — 全局工具 + 作用域层覆盖 + mode allowlist + 权限过滤。
   * 保留旧 ScopedToolRegistry 语义：application scope 仅承载全局工具，
   * modelFilter 参数保留但不过滤（与旧行为一致）。
   */
  materializeScoped(opts: {
    mode?: string
    modelFilter?: unknown
    permissions?: PermissionSet
    toolAllowlist?: string[]
  }): Record<string, unknown> {
    const { mode, permissions, toolAllowlist } = opts

    // 全局工具（含 MCP/Plugin 已注册）+ 作用域链覆盖 + restrict 过滤
    let defs = new Map<string, ToolDef>()
    for (const [name, def] of this.resolveWithRestrictions(undefined)) defs.set(name, def)

    // mode allowlist + config toolAllowlist 合并过滤
    const allowed = new Set<string>()
    toolAllowlist?.forEach((n) => allowed.add(n))
    if (mode) {
      const modeAllowlist = getModeToolAllowlist(mode)
      modeAllowlist?.forEach((n) => allowed.add(n))
    }
    if (allowed.size > 0) {
      defs = new Map([...defs].filter(([name]) => allowed.has(name)))
    }

    // 权限过滤（对齐旧 resolve 行为：PermissionSet.isAllowed(name, def.permission)）
    if (permissions) {
      defs = new Map([...defs].filter(([name, def]) => permissions.isAllowed(name, def.permission)))
    }

    // 过滤 invalid 内部工具，输出物化结果
    const out: Record<string, unknown> = {}
    for (const [name, def] of defs) {
      if (name === "invalid") continue
      out[name] = def
    }
    return out
  }

  /** 执行前单调守卫评估：返回拒绝原因字符串或 void 放行 */
  evaluateGuards(name: string, args: Record<string, unknown>, ctx: ToolContext): void | string {
    const scope = scopeOf(this.ctx)
    const guards: ToolGuard[] = []
    for (const guard of this.layers.global.guards.values()) guards.push(guard)
    for (const layer of this.layers.chainLayers(scope)) {
      for (const guard of layer.guards.values()) guards.push(guard)
    }
    for (const guard of guards) {
      const violation = guard({ name, args, ctx })
      if (typeof violation === "string") return violation
    }
    return undefined
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutionResult> {
    return this.executeScheduled({ id: ctx.toolCallID || "direct", name, args, signal: ctx.signal }, ctx)
  }

  // ── 四阶段调度器（批 10：对齐 dsh prepare→dispatch→finalize→finish 管线） ──
  // 单一执行入口，收敛所有工具执行路径，保证事件时机与错误码规范化。

  /**
   * 完整调度执行：prepare（守卫+权限+定位）→ dispatch（body+事件）→ finalize（post-execute+结果）→ finish。
   * @param exec 结构化执行输入
   * @param ctx 工具执行上下文（sessionID/workspace/凭据等）
   * @returns 结构化执行结果
   */
  async executeScheduled(exec: ToolExecutionInput, ctx: ToolContext, registryOverride?: ToolRegistry): Promise<ToolExecutionResult> {
    // 阶段 1: prepare — 定位工具、守卫门、取消预检
    const prepared = await this.prepare(exec, ctx, registryOverride)
    if (prepared.kind !== "ready") return this.finish(prepared.exec, prepared.result)

    // 阶段 2: dispatch — 执行 body（经 tools/execute 事件包裹）
    const dispatched = await this.dispatch(prepared.exec, ctx, registryOverride)
    if (dispatched.kind === "post-result") return this.finalize(prepared.exec, dispatched.result, ctx)
    return this.finish(prepared.exec, dispatched.result)
  }

  /** 阶段 1: prepare — 物化输入、守卫门、取消预检；返回下一阶段 */
  private async prepare(exec: ToolExecutionInput, ctx: ToolContext, registryOverride?: ToolRegistry): Promise<
    | { kind: "ready"; exec: ToolExecutionInput }
    | { kind: "final-result"; exec: ToolExecutionInput; result: ToolExecutionResult }
  > {
    const { name, args, id, signal } = exec

    // 取消预检：dispatch 前已取消 → 免 post-execute 的终止路径
    if (signal?.aborted) return { kind: "final-result", exec, result: toolAbortedBeforeDispatchResult() }

    // 未知工具定位（保留 invalid 自愈语义由调用方处理，此处仅报未知）
    // 优先用调用方传入的 registry（agent 专用注册表），否则用服务 registry/作用域解析
    const resolvedDef = registryOverride
      ? registryOverride.get(name)
      : (this.resolve(scopeOf(this.ctx)).get(name) ?? this.registry.get(name))
    if (!resolvedDef && !(registryOverride ?? this.registry).get(name)) {
      return { kind: "final-result", exec, result: toolErrorResult(`Unknown tool: ${name}`) }
    }

    // 守卫门（evaluateGuards：返回拒绝原因则阻断）
    const violation = this.evaluateGuards(name, args, ctx)
    if (typeof violation === "string") {
      return { kind: "final-result", exec, result: { success: false, error: `tool "${name}" denied by guard: ${violation}` } }
    }

    return { kind: "ready", exec }
  }

  /** 阶段 2: dispatch — 执行 body（经 tools/execute waterfall 包裹，供插件接管/替换） */
  private async dispatch(exec: ToolExecutionInput, ctx: ToolContext, registryOverride?: ToolRegistry): Promise<
    { kind: "result"; result: ToolExecutionResult } | { kind: "post-result"; result: ToolExecutionResult }
  > {
    const { name, args, id } = exec

    const executeBody = async (): Promise<ToolResult> => {
      // 优先用调用方 registry 定位（agent 专用）；否则服务作用域解析 + 服务 registry
      const resolvedDef = registryOverride
        ? registryOverride.get(name)
        : this.resolve(scopeOf(this.ctx)).get(name)
      if (resolvedDef) {
        const { result } = await settle(resolvedDef, { id, name, input: args }, ctx)
        return result
      }
      const execRegistry = registryOverride ?? this.registry
      return execRegistry.execute(name, args, ctx)
    }

    // tools/execute（waterfall）：插件可 next() 执行或自行实现（批 6 接缝）
    const events = this.ctx
    let result: ToolResult
    if (events.waterfall) {
      result = await events.waterfall("tools/execute", { id, name, args }, () => executeBody())
    } else {
      result = await executeBody()
    }

    // 取消：body 已被取消信号中止 → 规范化 aborted 结果
    if (exec.signal?.aborted) {
      return { kind: "post-result", result: toolAbortedResult() }
    }
    return { kind: "post-result", result }
  }

  /** 阶段 3: finalize — post-execute 事件 + 结果物化 + tools/result 归档 */
  private async finalize(exec: ToolExecutionInput, result: ToolExecutionResult, ctx: ToolContext): Promise<ToolExecutionResult> {
    const { name, id } = exec
    // tools/post-execute（waterfall）：插件可改写结果
    const events = this.ctx
    let effective = result
    if (events.waterfall) {
      const out = await events.waterfall("tools/post-execute", { id, name }, result, () => result as never)
      if (out && typeof out.success === "boolean") effective = out
    }
    // tools/result（emit）：只读归档
    try {
      events.emit("tools/result", { name, args: exec.args }, effective)
    } catch { /* 归档失败不阻塞 */ }
    return effective
  }

  /** 阶段 4: finish — 免 post-execute 的快速路径（prepare 失败/取消前终止） */
  private finish(exec: ToolExecutionInput, result: ToolExecutionResult): ToolExecutionResult {
    // 结果已物化，直接返回（prepare 阶段的 final-result 不走 finalize）
    return result
  }
}

export type { ModelFilter }
