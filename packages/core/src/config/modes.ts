import type { PermissionSet} from "../system/permission";
import { type PermissionRule } from "../system/permission"
import type { AgentProfile } from "./profile"
import { createDefaultRegistry, getGlobalAgentDir, getProjectAgentDir } from "./profile"

export type AgentMode = "assistant" | "expert" | "action" | "safe" | "plan"

const _registry = createDefaultRegistry()

/** 初始化时从目录加载自定义 Agent 配置 */
export function loadCustomAgents(workspace?: string): void {
  const globalDir = getGlobalAgentDir()
  _registry.loadFromDir(globalDir)
  if (workspace) {
    const projectDir = getProjectAgentDir(workspace)
    _registry.loadFromDir(projectDir)
  }
}

/** 注册自定义 Agent（运行时动态注册） */
export function registerAgent(profile: AgentProfile): void {
  _registry.registerBuiltin(profile)
}

/** 注册自定义 Agent（从 JSON 字符串） */
export function registerAgentFromJson(jsonStr: string): AgentProfile | null {
  return _registry.registerFromJson(jsonStr)
}

export function getModeConfig(mode: string): AgentProfile | undefined {
  return _registry.get(mode)
}

export function getAllModes(): AgentProfile[] {
  return _registry.getAll()
}

export function modeSystemPrompt(mode: string, basePrompt: string): string {
  const config = _registry.get(mode)
  if (!config) return basePrompt
  return `${basePrompt}\n\n[MODE: ${config.label}]\n${config.systemPromptSuffix}`
}

export function modeToPermissionSet(mode: string, base: PermissionSet): PermissionSet {
  return _registry.toPermissionSet(mode, base)
}

/** 获取工具的 allowlist */
export function getModeToolAllowlist(mode: string): string[] | undefined {
  return _registry.getToolAllowlist(mode)
}

/** 根据 mode 获取最大迭代次数 */
export function getModeMaxIterations(mode: string): number {
  const config = _registry.get(mode)
  return config?.maxIterations ?? 10
}

/** 根据 mode 获取系统提示后缀 */
export function getModeSystemPromptSuffix(mode: string): string {
  const config = _registry.get(mode)
  return config?.systemPromptSuffix ?? ""
}

