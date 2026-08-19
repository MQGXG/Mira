/**
 * System Prompt 服务 — ctx.systemPrompt
 *
 * 对齐 dsh `SystemPrompt`：variable / section / tools / context 四类动态贡献，
 * 均返回精确 disposer（effect 化，随 fiber 卸载自动回滚）。assemble() 组装时以
 * 当前 Agent 的 SourceManager（Mira 特色 7 源系统提示）为基础层，叠加插件的
 * sections / variables / tools 贡献 —— 即"包装 SourceManager"。
 *
 * 作用域化（批 8）：内部用 ScopedLayers 承载全局 + 作用域 shadow 层。
 * 在 agent 作用域 ctx 下注册的贡献写入作用域层，覆盖（shadow）全局同名项；
 * assemble 用 chainLayers 解析（最近作用域覆盖全局）。emit system-prompt/change，
 * waterfall system-prompt/assemble 可改写装配结果。
 */

import { Service } from "../vendor/cordis/index"
import type { Context } from "../vendor/cordis/index"
import type { SystemPromptService } from "../framework/context"
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf } from "../scope/index"

/** 组装上下文（对齐 dsh AssembleContext 简化面） */
export interface AssembleContext {
  scope?: unknown
  /**
   * 基础系统文本：优先由调用方传入（agent 循环的 SourceManager 分离式输出），
   * 避免 assemble 内部重复生成；未传入时经 ctx.agent 的 SourceManager 生成。
   */
  base?: string
}

/** 提示段（对齐 dsh PromptSection：唯一名 + 有限 order） */
export interface PromptSection {
  name: string
  order: number
  text: (context: AssembleContext) => string
}

/** 组装结果（对齐 dsh PromptAssembly 简化面：稳定 system + 动态 context） */
export interface PromptAssembly {
  system: string
  context: string
}

const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** 单作用域对系统提示的聚合贡献（对齐 dsh SystemPromptLayer 语义） */
interface PromptLayer {
  /** 命名提示段（section + context 段，`context:` 前缀区分） */
  sections: NamedEntries<{ order: number; text: (ctx: AssembleContext) => string }>
  /** 命名提示变量 */
  variables: NamedEntries<(ctx: AssembleContext) => string | undefined>
  /** 匿名工具 schema 提供者 */
  toolProviders: AnonymousEntries<(ctx: AssembleContext) => string>
  isEmpty(): boolean
}

function createPromptLayer(): PromptLayer {
  const layer: PromptLayer = {
    sections: new NamedEntries<{ order: number; text: (ctx: AssembleContext) => string }>(
      (name) => new Error(`prompt section "${name}" is already registered in this scope`),
    ),
    variables: new NamedEntries<(ctx: AssembleContext) => string | undefined>(
      (name) => new Error(`prompt variable "${name}" is already registered in this scope`),
    ),
    toolProviders: new AnonymousEntries<(ctx: AssembleContext) => string>(),
    isEmpty() {
      return this.sections.isEmpty() && this.variables.isEmpty() && this.toolProviders.isEmpty()
    },
  }
  return layer
}

export class MiraSystemPromptService extends Service implements SystemPromptService {
  static provide = "systemPrompt"
  static inject: string[] = []

  /** 全局 + 作用域层存储（root 实例创建，作用域实例共享注入） */
  readonly layers: ScopedLayers<PromptLayer>
  private runtimeContextSuppressed = 0

  constructor(ctx: Context, config: { layers?: ScopedLayers<PromptLayer> } = {}) {
    super(ctx, "systemPrompt")
    this.layers = config.layers
      ?? new ScopedLayers<PromptLayer>(
        () => createPromptLayer(),
        () => { this.ctx.emit("system-prompt/change") },
      )
  }

  /** 注册有序提示段（同名重复抛错，非有限 order 抛错） */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    return this.layers.effect(this.ctx, (layer) => {
      return layer.sections.insert(section.name, section)
    }, { label: "systemPrompt.section()" })
  }

  /** 注册动态 context 贡献（Mira 特有语义：并入运行时 context 块，order 偏移 100） */
  context(contribution: PromptSection): () => void {
    if (!Number.isFinite(contribution.order)) {
      throw new TypeError(`prompt context "${contribution.name}" order must be a finite number`)
    }
    return this.layers.effect(this.ctx, (layer) => {
      return layer.sections.insert(`context:${contribution.name}`, { ...contribution, order: contribution.order + 100 })
    }, { label: "systemPrompt.context()" })
  }

  /** 压制动态 runtime-context 贡献（多重压制相互独立、可分别撤销） */
  suppressRuntimeContext(): () => void {
    return this.ctx.effect(() => {
      this.runtimeContextSuppressed++
      return () => this.runtimeContextSuppressed--
    }, "systemPrompt.suppressRuntimeContext()")
  }

  /** 注册工具 schema 提供者（每次 assemble 求值，拼接进工具段） */
  tools(provider: (context: AssembleContext) => string): () => void {
    return this.layers.effect(this.ctx, (layer) => {
      return layer.toolProviders.append(provider)
    }, { label: "systemPrompt.tools()", notify: false })
  }

  /** 注册提示变量（`[a-z][a-z0-9_]*`；渲染时替换 `{{name}}` 占位符） */
  variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`invalid prompt variable name "${name}" (must match ${String(VARIABLE_NAME)})`)
    }
    return this.layers.effect(this.ctx, (layer) => {
      return layer.variables.insert(name, provider)
    }, { label: "systemPrompt.variable()" })
  }

  /** 沿作用域链解析有效 sections/variables/toolProviders（最近作用域覆盖全局） */
  private resolveLayers(context: AssembleContext): {
    sections: Map<string, { order: number; text: (ctx: AssembleContext) => string }>
    variables: Map<string, (ctx: AssembleContext) => string | undefined>
    toolProviders: Array<(ctx: AssembleContext) => string>
  } {
    // context.scope 是作用域 ctx（proxy）；scopeOf 提取 ScopeKey 供 ScopedLayers 寻址
    const scopeKey = context.scope === undefined ? undefined : scopeOf(context.scope as never)
    const sections = this.layers.merge(scopeKey, (l) => l.sections)
    const variables = this.layers.merge(scopeKey, (l) => l.variables)
    const toolProviders: Array<(ctx: AssembleContext) => string> = []
    for (const l of this.layers.chainLayers(scopeKey)) {
      for (const p of l.toolProviders.values()) toolProviders.push(p)
    }
    for (const p of this.layers.global.toolProviders.values()) toolProviders.push(p)
    return { sections, variables, toolProviders }
  }

  /** 组装：基础层（SourceManager 或调用方 base）+ 插件 sections/variables/tools */
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    let base = context.base ?? ""
    let dynamicContext = ""

    if (!context.base) {
      const agent = this.ctx.get("agent") as { getSourceManager?: () => { buildSeparated(ctx: unknown): Promise<{ system: string; context: string }> | null } } | undefined
      const sourceManager = agent?.getSourceManager?.()
      if (sourceManager) {
        const separated = await sourceManager.buildSeparated(context)
        base = separated?.system ?? ""
        dynamicContext = separated?.context ?? ""
      }
    }

    const { sections, variables, toolProviders } = this.resolveLayers(context)

    const sorted = [...sections.values()]
      .filter((s) => s.order < 100)
      .sort((a, b) => a.order - b.order)
    const contextSections = [...sections.values()]
      .filter((s) => s.order >= 100)
      .sort((a, b) => a.order - b.order)

    let system = [base, ...sorted.map((s) => s.text(context))].filter(Boolean).join("\n\n")
    for (const [name, provider] of variables) {
      const value = provider(context)
      system = system.replaceAll(`{{${name}}}`, value ?? "")
    }
    const toolText = toolProviders.map((p) => p(context)).filter(Boolean).join("\n")
    if (toolText) system = [system, toolText].filter(Boolean).join("\n\n")

    let assembly: PromptAssembly
    if (this.runtimeContextSuppressed > 0) {
      assembly = { system, context: "" }
    } else {
      const extraContext = contextSections.map((s) => s.text(context)).filter(Boolean).join("\n\n")
      assembly = {
        system,
        context: [dynamicContext, extraContext].filter(Boolean).join("\n\n"),
      }
    }

    // system-prompt/assemble（waterfall）：插件可改写最终装配结果
    const events = this.ctx
    if (events.waterfall) {
      const out = await events.waterfall("system-prompt/assemble", assembly, () => assembly as never)
      if (out && typeof out.system === "string") assembly = out
    }
    return assembly
  }
}
