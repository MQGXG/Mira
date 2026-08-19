/**
 * 工具列表 — 定义工具的分层分类
 * 不改变文件物理位置，而是在注册时附加元数据
 */

export type ToolCategory =
  | "core"           // 核心文件操作（始终可用）
  | "knowledge"      // 知识获取
  | "execution"      // 执行（受权限控制）
  | "orchestration"  // 编排（Agent 自身管理）
  | "infrastructure" // 基础设施

export interface ToolMeta {
  category: ToolCategory
  requiresPermission?: boolean
  timeout?: number
  supportsParallel?: boolean  // 声明是否支持并行执行
}

export const toolMetadata: Record<string, ToolMeta> = {
  read_file:    { category: "core", timeout: 10000, supportsParallel: true },
  write_file:   { category: "core", timeout: 10000, supportsParallel: true },
  edit_file:    { category: "core", timeout: 10000, supportsParallel: true },
  list_files:   { category: "core", timeout: 5000, supportsParallel: true },
  grep:         { category: "core", timeout: 15000, supportsParallel: true },
  glob:         { category: "core", timeout: 15000, supportsParallel: true },

  web_search:   { category: "knowledge", timeout: 15000, supportsParallel: true },
  web_browse:   { category: "knowledge", timeout: 30000, supportsParallel: true },
  web_fetch:    { category: "knowledge", timeout: 15000, supportsParallel: true },
  data_analysis:{ category: "knowledge", timeout: 60000, supportsParallel: true },

  bash:         { category: "execution", requiresPermission: true, timeout: 60000, supportsParallel: true },
  code_exec:    { category: "execution", requiresPermission: true, timeout: 60000, supportsParallel: true },
  image_gen:    { category: "execution", requiresPermission: true, timeout: 60000, supportsParallel: true },

  task_planner: { category: "orchestration", supportsParallel: true },
  delegate_task:{ category: "orchestration", timeout: 120000, supportsParallel: true },
  team_tool:    { category: "orchestration", supportsParallel: true },
  cron_tool:    { category: "orchestration", supportsParallel: true },
  worktree_tool:{ category: "orchestration", timeout: 30000, supportsParallel: true },

  lsp_definition:  { category: "infrastructure", supportsParallel: true },
  lsp_references:  { category: "infrastructure", supportsParallel: true },
  lsp_hover:       { category: "infrastructure", supportsParallel: true },
  lsp_symbols:     { category: "infrastructure", supportsParallel: true },
  lsp_implementations: { category: "infrastructure", supportsParallel: true },
  lsp_rename:      { category: "infrastructure", supportsParallel: false },

  git_status:      { category: "core", timeout: 15000, supportsParallel: true },
  git_diff:        { category: "core", timeout: 15000, supportsParallel: true },
  git_log:         { category: "core", timeout: 15000, supportsParallel: true },
  git_commit:      { category: "execution", requiresPermission: true, timeout: 15000, supportsParallel: false },
  workflow_run:    { category: "orchestration", timeout: 300000, supportsParallel: true },
  memory_search:   { category: "knowledge", timeout: 15000, supportsParallel: true },
  memory_recall:   { category: "knowledge", timeout: 15000, supportsParallel: true },
}

export function isToolParallel(name: string): boolean {
  return toolMetadata[name]?.supportsParallel ?? true
}

export function getToolsByCategory(category: ToolCategory): string[] {
  return Object.entries(toolMetadata)
    .filter(([, meta]) => meta.category === category)
    .map(([name]) => name)
}
