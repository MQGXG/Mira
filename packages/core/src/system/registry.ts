/**
 * ToolRegistry — 工具注册表核心
 * 职责：工具存储 + 注册 + 查询 + 执行
 * 物化逻辑委托给 ToolMaterializer
 * MCP/Plugin 生命周期委托给 MCPPluginRegistry
 */

import type { ToolDef, ToolContext, ToolResult} from "../shared/tool";
import { ToolCall, settle } from "../shared/tool"
import type { PermissionSet } from "./permission"
import { Effect } from "effect"
import * as ToolEffect from "../shared/tool-effect"
import { toolMetadata, type ToolCategory } from "../tools/shared/tool-meta"
import { logError } from "./logger"
import { ToolMaterializer, type Materialization, type ModelFilter } from "./tool-materializer"
import { MCPPluginRegistry } from "./mcp-plugin-registry"
import type { MCPServerConfig } from "../mcp/index"

export type { Materialization, ModelFilter } from "./tool-materializer"

export class ToolRegistry {
  private tools = new Map<string, ToolDef>()
  private effectDefs = new Map<string, ToolEffect.Def>()
  private materializer = new ToolMaterializer()
  private mcpPlugin: MCPPluginRegistry

  constructor() {
    this.mcpPlugin = new MCPPluginRegistry(this.tools, (def) => this.register(def))
  }

  // ── 工具注册 ──────────────────────────────────────────

  register(def: ToolDef): void {
    this.tools.set(def.name, def)
  }

  /** 可逆注册：移除工具（插件卸载/作用域回收时回滚，对齐 Cordis reversible effect） */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  registerEffect(def: ToolEffect.Def): void {
    this.effectDefs.set(def.id, def)
  }

  registerEffectLazy(effect: Effect.Effect<ToolEffect.Info>): void {
    Effect.runPromise(effect).then((info) => {
      Effect.runPromise(ToolEffect.init(info)).then((def) => {
        this.effectDefs.set(def.id, def)
      }).catch((err) => {
        logError(`[registry] 工具 "${info.id}" 初始化失败`, err)
      })
    })
  }

  // ── 工具查询 ──────────────────────────────────────────

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values())
  }

  getByCategory(category: ToolCategory): ToolDef[] {
    return Array.from(this.tools.values()).filter((t) => toolMetadata[t.name]?.category === category)
  }

  getCategory(toolName: string): ToolCategory | undefined {
    return toolMetadata[toolName]?.category
  }

  // ── 物化（委托给 ToolMaterializer）────────────────────

  materialize(permissions?: PermissionSet): Materialization {
    return this.materializer.materialize(this.tools, this.effectDefs, permissions)
  }

  materializeWithModel(modelFilter: ModelFilter, permissions?: PermissionSet): Materialization {
    return this.materializer.materializeWithModel(this.tools, this.effectDefs, modelFilter, permissions)
  }

  // ── 工具执行 ──────────────────────────────────────────

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const def = this.tools.get(name)
    if (def) {
      const { result } = await settle(def, { id: "direct", name, input: args }, ctx)
      return result
    }

    const effectDef = this.effectDefs.get(name)
    if (effectDef) {
      try {
        return await effectDef.execute(ToolEffect.coerceArgs(name, args, effectDef.jsonSchema || {}), ctx)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { success: false, error: msg }
      }
    }

    return { success: false, error: `Unknown tool: ${name}` }
  }

  // ── MCP/Plugin（委托给 MCPPluginRegistry）─────────────

  async initMCP(configs: MCPServerConfig[]): Promise<void> {
    return this.mcpPlugin.initMCP(configs)
  }

  getMCPManager() {
    return this.mcpPlugin.getMCPManager()
  }

  async refreshMCP(): Promise<void> {
    return this.mcpPlugin.refreshMCP()
  }

  async initPlugins(workspace: string): Promise<void> {
    return this.mcpPlugin.initPlugins(workspace)
  }

  getPluginManager() {
    return this.mcpPlugin.getPluginManager()
  }

  async executePluginHook(hookName: string, ...args: unknown[]): Promise<unknown[]> {
    return this.mcpPlugin.executePluginHook(hookName, ...args)
  }

  async refreshPlugins(): Promise<void> {
    return this.mcpPlugin.refreshPlugins()
  }

  scanCustomTools(dirs: string[]): void {
    return this.mcpPlugin.scanCustomTools(dirs)
  }
}
