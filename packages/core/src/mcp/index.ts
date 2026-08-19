/**
 * MCP (Model Context Protocol) 客户端
 * 支持本地和远程 MCP 服务器
 */

import { Client } from "@modelcontextprotocol/sdk/client"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp"
import { z } from "zod"
import { make, type ToolDef, type ToolContext, type ToolResult } from "../shared/tool"

// MCP 服务器配置 Schema
export const MCPServerConfigSchema = z.object({
  name: z.string().describe("服务器名称"),
  type: z.enum(["local", "remote"]).describe("服务器类型: local (stdio) 或 remote (HTTP)"),
  command: z.array(z.string()).optional().describe("本地服务器命令 (type=local 时必填)"),
  url: z.string().optional().describe("远程服务器 URL (type=remote 时必填)"),
  environment: z.record(z.string(), z.string()).optional().describe("环境变量"),
  headers: z.record(z.string(), z.string()).optional().describe("HTTP 头 (type=remote 时)"),
  enabled: z.boolean().optional().default(true).describe("是否启用"),
})

export type MCPServerConfig = z.infer<typeof MCPServerConfigSchema>

// MCP 工具定义
interface MCPToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// MCP 客户端连接
interface MCPConnection {
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport
  serverName: string
  tools: MCPToolDef[]
  connected: boolean
}

/**
 * MCP 客户端管理器
 * 管理多个 MCP 服务器连接
 */
export class MCPManager {
  private connections = new Map<string, MCPConnection>()
  private config: MCPServerConfig[] = []

  /**
   * 设置 MCP 服务器配置
   */
  setConfig(config: MCPServerConfig[]): void {
    this.config = config
  }

  /**
   * 连接到所有启用的 MCP 服务器
   */
  async connectAll(): Promise<void> {
    const enabledServers = this.config.filter(c => c.enabled !== false)
    
    for (const serverConfig of enabledServers) {
      try {
        await this.connect(serverConfig)
      } catch (error) {
        console.error(`[MCP] Failed to connect to ${serverConfig.name}:`, error)
      }
    }
  }

  /**
   * 连接到单个 MCP 服务器
   */
  async connect(config: MCPServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      console.log(`[MCP] Already connected to ${config.name}`)
      return
    }

    const client = new Client(
      {
        name: "mira",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    )

    let transport: StdioClientTransport | StreamableHTTPClientTransport

    if (config.type === "local") {
      if (!config.command || config.command.length === 0) {
        throw new Error(`[MCP] Local server ${config.name} requires command`)
      }

      const [command, ...args] = config.command
      transport = new StdioClientTransport({
        command,
        args,
        env: {
          ...process.env,
          ...config.environment,
        } as Record<string, string>,
      })
    } else {
      if (!config.url) {
        throw new Error(`[MCP] Remote server ${config.name} requires url`)
      }

      transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      )
    }

    await client.connect(transport)

    // 获取工具列表
    const toolsResult = await client.listTools()
    const tools: MCPToolDef[] = toolsResult.tools.map(tool => ({
      name: `${config.name}_${tool.name}`,
      description: tool.description || `MCP tool from ${config.name}`,
      inputSchema: tool.inputSchema,
    }))

    this.connections.set(config.name, {
      client,
      transport,
      serverName: config.name,
      tools,
      connected: true,
    })

    console.log(`[MCP] Connected to ${config.name}: ${tools.length} tools`)
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    for (const [name, connection] of this.connections) {
      try {
        await connection.client.close()
        console.log(`[MCP] Disconnected from ${name}`)
      } catch (error) {
        console.error(`[MCP] Error disconnecting from ${name}:`, error)
      }
    }
    this.connections.clear()
  }

  /**
   * 获取所有可用工具
   */
  getTools(): MCPToolDef[] {
    const tools: MCPToolDef[] = []
    for (const connection of this.connections.values()) {
      if (connection.connected) {
        tools.push(...connection.tools)
      }
    }
    return tools
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const connection = this.connections.get(serverName)
    if (!connection || !connection.connected) {
      return { success: false, error: `MCP server ${serverName} not connected` }
    }

    try {
      // 移除服务器名称前缀获取原始工具名
      const originalToolName = toolName.startsWith(`${serverName}_`)
        ? toolName.slice(serverName.length + 1)
        : toolName

      const result = await connection.client.callTool({
        name: originalToolName,
        arguments: args,
      })

      // 处理结果
      const callResult = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> }
      
      if (callResult.isError) {
        const errorContent = callResult.content?.find((c: { type: string }) => c.type === "text")
        return {
          success: false,
          error: errorContent && "text" in errorContent ? errorContent.text : "Tool execution failed",
        }
      }

      // 提取文本内容
      const textContent = callResult.content?.find((c: { type: string }) => c.type === "text")
      if (textContent && "text" in textContent) {
        return { success: true, output: textContent.text }
      }

      return { success: true, output: JSON.stringify(callResult.content) }
    } catch (error: any) {
      return { success: false, error: error.message || "Unknown error" }
    }
  }

  /**
   * 检查服务器是否已连接
   */
  isConnected(serverName: string): boolean {
    const connection = this.connections.get(serverName)
    return connection?.connected === true
  }

  /**
   * 获取服务器状态
   */
  getStatus(): Array<{ name: string; connected: boolean; toolCount: number }> {
    return Array.from(this.connections.values()).map(conn => ({
      name: conn.serverName,
      connected: conn.connected,
      toolCount: conn.tools.length,
    }))
  }
}

// 全局 MCP 管理器实例
let globalMCPManager: MCPManager | null = null

/**
 * 获取全局 MCP 管理器
 */
export function getMCPManager(): MCPManager {
  if (!globalMCPManager) {
    globalMCPManager = new MCPManager()
  }
  return globalMCPManager
}

/**
 * 从 MCP 工具创建 Mira 工具
 */
export function createMCPTool(
  mcpManager: MCPManager,
  serverName: string,
  toolDef: MCPToolDef
): ToolDef {
  // 将 JSON Schema 转换为 Zod schema
  const inputSchema = jsonSchemaToZod(toolDef.inputSchema)

  return make({
    name: toolDef.name,
    description: `[MCP: ${serverName}] ${toolDef.description}`,
    inputSchema,
    outputSchema: z.string(),
    permission: "mcp",
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const result = await mcpManager.callTool(serverName, toolDef.name, input)
      return {
        success: result.success,
        output: result.output,
        error: result.error,
      }
    },
  })
}

/**
 * 将 JSON Schema 转换为 Zod schema
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  if (!schema || typeof schema !== "object") {
    return z.record(z.string(), z.unknown())
  }

  const type = schema.type as string
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  const required = schema.required as string[] | undefined

  if (type === "object" && properties) {
    const shape: Record<string, z.ZodType> = {}

    for (const [key, propSchema] of Object.entries(properties)) {
      const isRequired = required?.includes(key) ?? false
      const propZod = jsonSchemaToZod(propSchema)
      shape[key] = isRequired ? propZod : propZod.optional()
    }

    return z.object(shape)
  }

  if (type === "string") {
    return z.string()
  }
  if (type === "number" || type === "integer") {
    return z.number()
  }
  if (type === "boolean") {
    return z.boolean()
  }
  if (type === "array") {
    const items = schema.items as Record<string, unknown> | undefined
    if (items) {
      return z.array(jsonSchemaToZod(items))
    }
    return z.array(z.unknown())
  }

  // 默认返回 record
  return z.record(z.string(), z.unknown())
}

/**
 * 初始化 MCP 管理器并连接服务器
 */
export async function initMCP(config: MCPServerConfig[]): Promise<MCPManager> {
  const manager = getMCPManager()
  manager.setConfig(config)
  await manager.connectAll()
  return manager
}
