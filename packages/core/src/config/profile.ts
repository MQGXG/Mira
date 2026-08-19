import { readFileSync, existsSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { homedir } from "os"
import type { PermissionRule } from "../system/permission"
import { PermissionSet } from "../system/permission"

/**
 * Agent 配置 — 可序列化为 JSON 文件
 * 参考 OpenCode 的 agent 配置方式（opencode.json）
 */
export interface AgentProfile {
  id: string
  label: string
  description: string
  maxIterations: number
  systemPromptSuffix: string
  permissionRules: PermissionRule[]
  toolAllowlist?: string[]
}

/**
 * Agent 配置注册表
 * 加载优先级：内置默认 → 全局配置 → 项目配置
 */
export class AgentProfileRegistry {
  private profiles = new Map<string, AgentProfile>()

  /** 注册内置 Agent */
  registerBuiltin(profile: AgentProfile): void {
    this.profiles.set(profile.id, profile)
  }

  /** 从文件加载 Agent 配置 */
  loadFromFile(filePath: string): AgentProfile | null {
    try {
      const raw = readFileSync(filePath, "utf-8")
      const json = JSON.parse(raw)
      if (!json.id) return null
      return json as AgentProfile
    } catch {
      return null
    }
  }

  /** 从目录加载所有 Agent 配置 */
  loadFromDir(dirPath: string): void {
    if (!existsSync(dirPath)) return
    try {
      const files = readdirSync(dirPath)
      for (const f of files) {
        if (f.endsWith(".json")) {
          const profile = this.loadFromFile(join(dirPath, f))
          if (profile) this.profiles.set(profile.id, profile)
        }
      }
    } catch { /* 目录读取失败不阻塞 */ }
  }

  /** 获取指定 Agent 配置 */
  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id)
  }

  /** 获取所有 Agent 配置 */
  getAll(): AgentProfile[] {
    return Array.from(this.profiles.values())
  }

  /** 将 Agent 配置转为 PermissionSet */
  toPermissionSet(id: string, base: PermissionSet): PermissionSet {
    const profile = this.get(id)
    if (!profile) return base
    const allRules = [...profile.permissionRules, ...base.getAll()]
    return new PermissionSet(allRules)
  }

  /** 从 JSON 字符串直接注册一个 Agent */
  registerFromJson(jsonStr: string): AgentProfile | null {
    try {
      const profile = JSON.parse(jsonStr) as AgentProfile
      if (!profile.id) return null
      this.profiles.set(profile.id, profile)
      return profile
    } catch {
      return null
    }
  }

  /** 获取工具的 allowlist */
  getToolAllowlist(id: string): string[] | undefined {
    return this.profiles.get(id)?.toolAllowlist
  }
}

/** 全局默认内置 Agent 配置 */
export function createDefaultRegistry(): AgentProfileRegistry {
  const registry = new AgentProfileRegistry()

  registry.registerBuiltin({
    id: "assistant",
    label: "助手",
    description: "日常问答、写作、分析",
    maxIterations: 10,
    systemPromptSuffix: "You are a helpful assistant. Use tools to provide accurate, up-to-date answers.",
    permissionRules: [
      { action: "bash", resource: "*", effect: "ask" },
      { action: "code_exec", resource: "*", effect: "ask" },
    ],
    // 日常问答工具集：保留全量常用工具（含文档/图表生成），
    // 提供 get_current_time / change_directory 轻量工具
    toolAllowlist: [
      "read_file", "write_file", "edit_file", "apply_patch", "list_files", "grep", "glob", "code_search",
      "web_search", "web_fetch", "web_browse", "data_analysis", "create_chart",
      "bash", "run_code", "git_status", "git_diff", "git_log", "git_commit",
      "create_docx", "create_xlsx", "create_pptx", "create_webpage", "create_mockup", "create_svg", "memory_search", "memory_recall",
      "memory_activate", "memory_graph_query", "memory_graph_add_node", "memory_graph_add_edge", "memory_graph_decay",
      "officecli_inspect", "officecli_get", "officecli_query", "officecli_issues", "officecli_validate", "officecli_edit", "officecli_merge",
      "question", "todo_write", "search_history", "skills_list", "skill_view", "get_current_time", "change_directory",
      // 运行期自修改：Agent 可定义/激活/卸载自己的插件（"一切皆插件"终局）
      "mira_plugin_define", "mira_plugin_run", "mira_plugin_stop", "mira_plugin_undefine", "mira_plugin_list", "mira_plugin_inspect",
    ],
  })

  registry.registerBuiltin({
    id: "expert",
    label: "专家",
    description: "深度研究、数据分析",
    maxIterations: 25,
    systemPromptSuffix: "You are a domain expert. Use tools for research, analysis, and verification.",
    permissionRules: [
      { action: "bash", resource: "*", effect: "ask" },
    ],
  })

  registry.registerBuiltin({
    id: "action",
    label: "执行",
    description: "自动化任务、批量处理",
    maxIterations: 50,
    systemPromptSuffix: "You are an automation agent. Execute tasks end-to-end using all available tools.",
    permissionRules: [],
  })

  registry.registerBuiltin({
    id: "safe",
    label: "安全",
    description: "只读探索",
    maxIterations: 5,
    systemPromptSuffix: "You are in read-only mode. Explore and analyze without modifying anything.",
    permissionRules: [
      { action: "write_file", resource: "*", effect: "deny" },
      { action: "edit_file", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "code_exec", resource: "*", effect: "deny" },
    ],
    toolAllowlist: ["read_file", "list_files", "grep", "glob", "web_search", "web_browse", "data_analysis", "get_current_time", "memory_activate", "memory_graph_query"],
  })

  registry.registerBuiltin({
    id: "plan",
    label: "规划",
    description: "代码分析、方案设计",
    maxIterations: 15,
    systemPromptSuffix: "You are a planning agent. Analyze code and design implementation plans.",
    permissionRules: [
      { action: "write_file", resource: "*", effect: "deny" },
      { action: "edit_file", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "code_exec", resource: "*", effect: "deny" },
      { action: "cron_tool", resource: "*", effect: "deny" },
      { action: "worktree_tool", resource: "*", effect: "deny" },
      { action: "image_gen", resource: "*", effect: "deny" },
    ],
    toolAllowlist: ["read_file", "list_files", "grep", "glob", "web_search", "web_browse", "data_analysis", "lsp_definition", "lsp_references", "lsp_hover", "lsp_symbols", "lsp_implementations", "get_current_time", "memory_activate", "memory_graph_query"],
  })

  return registry
}

/** 获取 Agent 配置目录路径 */
export function getGlobalAgentDir(): string {
  return join(homedir(), ".config", "mira", "agents")
}

export function getProjectAgentDir(workspace: string): string {
  return join(workspace, ".mira", "agents")
}
