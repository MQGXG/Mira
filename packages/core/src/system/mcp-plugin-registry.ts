/**
 * MCPPluginRegistry — MCP 和 Plugin 的生命周期管理
 * 从 registry.ts 拆分，职责单一
 */

import * as fs from "fs"
import * as path from "path"
import { MCPManager, createMCPTool, type MCPServerConfig } from "../mcp/index"
import { PluginManager } from "../plugin/index"
import type { ToolDef } from "../shared/tool"
import { logError } from "./logger"

export class MCPPluginRegistry {
  private mcpManager: MCPManager | null = null
  private pluginManager: PluginManager | null = null
  private registerTool: (def: ToolDef) => void
  private tools: Map<string, ToolDef>

  constructor(
    tools: Map<string, ToolDef>,
    registerTool: (def: ToolDef) => void,
  ) {
    this.tools = tools
    this.registerTool = registerTool
  }

  // ── MCP 管理 ──────────────────────────────────────────

  /** 初始化 MCP 并注册工具 */
  async initMCP(configs: MCPServerConfig[]): Promise<void> {
    this.mcpManager = new MCPManager()
    this.mcpManager.setConfig(configs)

    try {
      await this.mcpManager.connectAll()

      const mcpTools = this.mcpManager.getTools()
      for (const toolDef of mcpTools) {
        const serverName = toolDef.name.split("_")[0]
        const tool = createMCPTool(this.mcpManager, serverName, toolDef)
        this.registerTool(tool)
      }

      console.log(`[registry] MCP initialized: ${mcpTools.length} tools registered`)
    } catch (error) {
      logError("[registry] MCP initialization failed", error)
    }
  }

  /** 获取 MCP 管理器 */
  getMCPManager(): MCPManager | null {
    return this.mcpManager
  }

  /** 刷新 MCP 工具 */
  async refreshMCP(): Promise<void> {
    if (!this.mcpManager) return

    // 移除旧的 MCP 工具
    for (const [name, tool] of this.tools) {
      if (tool.description.startsWith("[MCP:")) {
        this.tools.delete(name)
      }
    }

    // 重新连接并注册
    await this.mcpManager.disconnectAll()
    await this.mcpManager.connectAll()

    const mcpTools = this.mcpManager.getTools()
    for (const toolDef of mcpTools) {
      const serverName = toolDef.name.split("_")[0]
      const tool = createMCPTool(this.mcpManager, serverName, toolDef)
      this.registerTool(tool)
    }
  }

  // ── Plugin 管理 ───────────────────────────────────────

  /** 初始化插件系统 */
  async initPlugins(workspace: string): Promise<void> {
    this.pluginManager = new PluginManager(workspace)

    try {
      await this.pluginManager.loadPlugins()

      await this.pluginManager.initializePlugins({
        workspace,
        config: { enabled: true },
      })

      const pluginTools = this.pluginManager.getTools()
      for (const tool of pluginTools) {
        this.registerTool(tool)
      }

      console.log(`[registry] Plugins initialized: ${pluginTools.length} tools registered`)
    } catch (error) {
      logError("[registry] Plugin initialization failed", error)
    }
  }

  /** 获取插件管理器 */
  getPluginManager(): PluginManager | null {
    return this.pluginManager
  }

  /** 执行插件钩子 */
  async executePluginHook(hookName: string, ...args: unknown[]): Promise<unknown[]> {
    if (!this.pluginManager) return []
    return this.pluginManager.executeHook(hookName, ...args)
  }

  /** 刷新插件 */
  async refreshPlugins(): Promise<void> {
    if (!this.pluginManager) return

    // 移除旧的插件工具
    for (const [name, tool] of this.tools) {
      if (tool.description.startsWith("[Plugin:")) {
        this.tools.delete(name)
      }
    }

    await this.pluginManager.destroyAll()

    await this.pluginManager.loadPlugins()
    await this.pluginManager.initializePlugins({
      workspace: process.cwd(),
      config: { enabled: true },
    })

    const pluginTools = this.pluginManager.getTools()
    for (const tool of pluginTools) {
      this.registerTool(tool)
    }
  }

  // ── 自定义工具扫描 ────────────────────────────────────

  /** 扫描自定义工具文件 */
  scanCustomTools(dirs: string[]): void {
    for (const dir of dirs) {
      const searchPaths = ["tool", "tools"]
      for (const subdir of searchPaths) {
        const fullPath = path.join(dir, subdir)
        if (!fs.existsSync(fullPath)) continue
        const entries = fs.readdirSync(fullPath)
        for (const entry of entries) {
          if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue
          const modPath = path.join(fullPath, entry)
          import(modPath).then((mod) => {
            for (const [key, value] of Object.entries(mod as Record<string, unknown>)) {
              if (value && typeof value === "object" && "name" in value && "execute" in value) {
                this.registerTool(value as ToolDef)
              }
            }
          }).catch((err) => {
            logError(`[registry] 加载自定义工具失败: ${modPath}`, err)
          })
        }
      }
    }
  }
}
