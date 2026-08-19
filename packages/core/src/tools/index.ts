/**
 * 所有工具统一导出 — 类似 OpenCode 的 application-tools.ts
 * 新增工具只需在这里加一行
 */

export { writeFileTool } from "./core/write-file"
export { listFilesTool } from "./core/list-files"
export { webSearchTool } from "./knowledge/web-search"
export { webFetchTool } from "./knowledge/web-fetch"
export { codeSearchTool } from "./core/code-search"
export { questionTool } from "./interaction/question"
export { grepTool } from "./core/grep"
export { globTool } from "./core/glob"
export { codeExecTool } from "./execution/code-exec"
export { bashTool } from "./execution/bash"
export { editFileTool } from "./core/edit-file"
export { gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool } from "./core/git"
export { createDocxTool } from "./core/create-docx"
export { createXlsxTool } from "./core/create-xlsx"
export { createPptxTool } from "./core/create-pptx"
export { createWebpageTool } from "./core/create-webpage"
export { createMockupTool } from "./core/create-mockup"
export { createSvgTool } from "./core/create-svg"
export { searchHistoryTool } from "./core/search-history"
export { memorySearchTool, memoryRecallTool } from "./knowledge/memory"
export { createChartTool } from "./knowledge/create-chart"
export { memoryActivateTool, setDynamicMemoryManager, getDynamicMemoryManager } from "./knowledge/memory-activate"
export {
  memoryGraphAddNodeTool,
  memoryGraphAddEdgeTool,
  memoryGraphQueryTool,
  memoryGraphDecayTool,
} from "./knowledge/memory-graph"
export { spawnAgentTool, waitAgentsTool, listSubagentsTool } from "./orchestrate/agent-tools"
export { createMCPTool } from "../mcp/index"
export { applyPatchTool } from "./core/apply-patch"
