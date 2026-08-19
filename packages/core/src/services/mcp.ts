/**
 * MCP 服务 — ctx.mcp
 * Model Context Protocol：本地 stdio + 远程 HTTP 服务器，工具动态注册
 */

import { Service } from "../vendor/cordis/index"
import { ToolRegistry } from "../system/registry"
import type { MCPServerConfig } from "../mcp/index"
import type { MCPService } from "../framework/context"
import type { MiraToolService } from "./tools"

export class MiraMCPService extends Service implements MCPService {
  /** 服务名声明（Service 构造默认名） */
  static provide = "mcp"
  /** 依赖工具服务（其 registry 提供 MCP 工具注册目标） */
  static inject = ["tools"]
  private registry: ToolRegistry | null = null

  constructor(ctx: import("../vendor/cordis/index").Context, config: { registry?: ToolRegistry } = {}) {
    super(ctx, "mcp")
    // 优先注入的共享 registry；否则取注入的 tools 服务实例
    this.registry = config.registry
      ?? (this.ctx.tools as MiraToolService | undefined)?.registry
      ?? null
  }

  async init(configs: MCPServerConfig[]): Promise<void> {
    if (!this.registry) return
    await this.registry.initMCP(configs)
  }

  async refresh(): Promise<void> {
    await this.registry?.refreshMCP()
  }

  listTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const mcp = this.registry?.getMCPManager()
    if (!mcp) return []
    return mcp.getTools?.() ?? []
  }
}
