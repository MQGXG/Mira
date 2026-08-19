/**
 * 注册表初始化 — 从 index.ts 拆分以打破循环依赖
 */
import { ToolRegistry } from "./registry"
import { readFileTool } from "../tools/core/read-file"
import { invalidTool } from "../tools/core/invalid"
import { getCurrentTimeTool } from "../tools/core/get-current-time"
import { changeDirectoryTool } from "../tools/core/change-directory"
import {
  writeFileTool, listFilesTool,
  webSearchTool, webFetchTool, codeSearchTool, questionTool,
  grepTool, globTool, codeExecTool, bashTool, editFileTool,
} from "../tools/index"
import { skillsListTool, skillViewTool } from "../skill/skill-tools"
import { createXlsxTool } from "../tools/core/create-xlsx"
import { createPptxTool } from "../tools/core/create-pptx"
import { createWebpageTool } from "../tools/core/create-webpage"
import { createMockupTool } from "../tools/core/create-mockup"
import { createSvgTool } from "../tools/core/create-svg"
import { memorySearchTool, memoryRecallTool } from "../tools/knowledge/memory"
import { memoryActivateTool } from "../tools/knowledge/memory-activate"
import {
  memoryGraphAddNodeTool, memoryGraphAddEdgeTool,
  memoryGraphQueryTool, memoryGraphDecayTool,
} from "../tools/knowledge/memory-graph"
import { dataAnalysisTool } from "../tools/knowledge/data-analysis"
import { webBrowseTool } from "../tools/knowledge/web-browse"
import { createChartTool } from "../tools/knowledge/create-chart"
import { cronTool } from "../tools/orchestrate/cron-tool"
import { taskTool } from "../tools/orchestrate/task-tool"
import { delegateTaskTool } from "../tools/orchestrate/delegate-task"
import { imageGenTool } from "../tools/execution/image-gen"
import { worktreeTool } from "../tools/orchestrate/worktree-tool"
import { teamTool } from "../tools/orchestrate/team-tool"
import { lspDefinitionTool, lspReferencesTool, lspHoverTool, lspSymbolsTool, lspImplementationsTool, lspRenameTool } from "../tools/infra/lsp-tool"
import { gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool } from "../tools/core/git"
import { createDocxTool } from "../tools/core/create-docx"
import { searchHistoryTool } from "../tools/core/search-history"
import { spawnAgentTool, waitAgentsTool, listSubagentsTool } from "../tools/orchestrate/agent-tools"
import { workflowRunTool } from "../tools/orchestrate/workflow-tool"
import { applyPatchTool } from "../tools/core/apply-patch"
import { todoTool } from "../tools/core/todo-tool"
import { registerOfficeCapability } from "../capability/office-cli-provider"
import { getOffice } from "../capability/office"
import {
  officecliInspectTool, officecliGetTool, officecliQueryTool,
  officecliIssuesTool, officecliValidateTool, officecliEditTool, officecliMergeTool,
} from "../tools/office/officecli-tools"
import type { MCPServerConfig } from "../mcp/index"

/**
 * 条件注册 officecli_* 工具（对齐 dsh 条件注入）
 * office 能力缝无 provider 或二进制不可用时，这些工具不注册（Agent 看不到，fail-closed）。
 */
export function registerOfficeTools(registry: ToolRegistry): void {
  if (!getOffice()?.isAvailable()) return
  registry.register(officecliInspectTool)
  registry.register(officecliGetTool)
  registry.register(officecliQueryTool)
  registry.register(officecliIssuesTool)
  registry.register(officecliValidateTool)
  registry.register(officecliEditTool)
  registry.register(officecliMergeTool)
}

export function createDefaultRegistry(): ToolRegistry {
  // 注册 office 能力缝 provider（可逆卸载、幂等；生命周期=应用生命周期）
  registerOfficeCapability()
  const registry = new ToolRegistry()
  registry.register(readFileTool)
  registry.register(invalidTool)
  registry.register(getCurrentTimeTool)
  registry.register(changeDirectoryTool)
  registry.register(writeFileTool)
  registry.register(listFilesTool)
  registry.register(webSearchTool)
  registry.register(webFetchTool)
  registry.register(codeSearchTool)
  registry.register(questionTool)
  registry.register(grepTool)
  registry.register(globTool)
  registry.register(codeExecTool)
  registry.register(bashTool)
  registry.register(editFileTool)
  registry.register(skillsListTool)
  registry.register(skillViewTool)
  registry.register(dataAnalysisTool)
  registry.register(webBrowseTool)
  registry.register(createChartTool)
  registry.register(cronTool)
  registry.register(taskTool)
  registry.register(delegateTaskTool)
  registry.register(imageGenTool)
  registry.register(worktreeTool)
  registry.register(teamTool)
  registry.register(lspDefinitionTool)
  registry.register(lspReferencesTool)
  registry.register(lspHoverTool)
  registry.register(lspSymbolsTool)
  registry.register(lspImplementationsTool)
  registry.register(lspRenameTool)
  registry.register(gitStatusTool)
  registry.register(gitDiffTool)
  registry.register(gitLogTool)
  registry.register(gitCommitTool)
  registry.register(createDocxTool)
  registry.register(searchHistoryTool)
  registry.register(memorySearchTool)
  registry.register(memoryRecallTool)
  registry.register(memoryActivateTool)
  registry.register(memoryGraphAddNodeTool)
  registry.register(memoryGraphAddEdgeTool)
  registry.register(memoryGraphQueryTool)
  registry.register(memoryGraphDecayTool)
  registry.register(spawnAgentTool)
  registry.register(waitAgentsTool)
  registry.register(listSubagentsTool)
  registry.register(workflowRunTool)
  registry.register(applyPatchTool)
  registry.register(todoTool)
  registry.register(createXlsxTool)
  registry.register(createPptxTool)
  registry.register(createWebpageTool)
  registry.register(createMockupTool)
  registry.register(createSvgTool)
  registerOfficeTools(registry)
  return registry
}

/**
 * 初始化 MCP 服务器
 * @param registry 工具注册表
 * @param mcpConfigs MCP 服务器配置列表
 */
export async function initMCP(
  registry: ToolRegistry,
  mcpConfigs: MCPServerConfig[]
): Promise<void> {
  await registry.initMCP(mcpConfigs)
}

/**
 * 初始化插件系统
 * @param registry 工具注册表
 * @param workspace 工作空间路径
 */
export async function initPlugins(
  registry: ToolRegistry,
  workspace: string
): Promise<void> {
  await registry.initPlugins(workspace)
}
