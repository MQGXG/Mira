const STORAGE_KEY = "tool_fold_preferences"

export interface ToolFoldConfig {
  defaultExpanded: boolean
  maxPreviewLines: number
}

const defaultConfigs: Record<string, ToolFoldConfig> = {
  read_file:    { defaultExpanded: true,  maxPreviewLines: 30 },
  write_file:   { defaultExpanded: true,  maxPreviewLines: 10 },
  edit_file:    { defaultExpanded: true,  maxPreviewLines: 20 },
  bash:         { defaultExpanded: false, maxPreviewLines: 5 },
  code_exec:    { defaultExpanded: false, maxPreviewLines: 5 },
  web_search:   { defaultExpanded: true,  maxPreviewLines: 10 },
  web_browse:   { defaultExpanded: true,  maxPreviewLines: 10 },
  grep:         { defaultExpanded: true,  maxPreviewLines: 15 },
  glob:         { defaultExpanded: true,  maxPreviewLines: 15 },
  list_files:   { defaultExpanded: false, maxPreviewLines: 10 },
  data_analysis:{ defaultExpanded: true,  maxPreviewLines: 20 },
  image_gen:    { defaultExpanded: true,  maxPreviewLines: 10 },
  create_docx:  { defaultExpanded: true,  maxPreviewLines: 10 },
  delegate_task:{ defaultExpanded: false, maxPreviewLines: 8 },
  question:     { defaultExpanded: true,  maxPreviewLines: 5 },
  cron_tool:    { defaultExpanded: false, maxPreviewLines: 10 },
  workflow_run: { defaultExpanded: true,  maxPreviewLines: 15 },
  default:      { defaultExpanded: false, maxPreviewLines: 8 },
}

function loadSettings(): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem("settings") || "{}") as Record<string, any>
  } catch {
    return {}
  }
}

function loadOverrides(): Record<string, Partial<ToolFoldConfig>> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, Partial<ToolFoldConfig>>
  } catch {
    return {}
  }
}

function saveOverrides(overrides: Record<string, Partial<ToolFoldConfig>>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
}

export function getFoldConfig(toolName: string): ToolFoldConfig {
  const settings = loadSettings()
  let base = defaultConfigs[toolName] || defaultConfigs.default

  const shellTools = ["bash", "code_exec"]
  const editTools = ["write_file", "edit_file", "apply_patch"]

  if (settings.expandShellTools && shellTools.includes(toolName)) {
    base = { ...base, defaultExpanded: true }
  }
  if (settings.expandEditTools && editTools.includes(toolName)) {
    base = { ...base, defaultExpanded: true }
  }

  const overrides = loadOverrides()
  const override = overrides[toolName]
  if (!override) return base
  return { ...base, ...override }
}

export function setFoldConfig(toolName: string, config: Partial<ToolFoldConfig>): void {
  const overrides = loadOverrides()
  overrides[toolName] = { ...(overrides[toolName] || {}), ...config }
  saveOverrides(overrides)
}

export function expandToolOutput(result: string, toolName: string): { preview: string; hasMore: boolean; totalLines: number } {
  const lines = result.split("\n")
  const config = getFoldConfig(toolName)
  if (lines.length <= config.maxPreviewLines) {
    return { preview: result, hasMore: false, totalLines: lines.length }
  }
  return {
    preview: lines.slice(0, config.maxPreviewLines).join("\n"),
    hasMore: true,
    totalLines: lines.length,
  }
}
