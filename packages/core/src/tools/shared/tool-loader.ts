/**
 * 延迟工具加载器 — 参考 Claude Code 的 Deferred Tool Loading
 * 工具按需加载，减少初始 prompt 大小
 */

import { toolMetadata, type ToolMeta } from "./tool-meta"

// 工具关键词索引（用于搜索匹配）
const TOOL_KEYWORDS: Record<string, string[]> = {
  read_file: ["read", "open", "查看", "读取", "打开", "show", "cat", "content", "文件内容"],
  write_file: ["write", "create", "save", "写入", "创建", "保存", "生成文件", "新建"],
  edit_file: ["edit", "replace", "modify", "修改", "替换", "编辑", "改动", "更新"],
  list_files: ["list", "ls", "dir", "directory", "文件夹", "目录", "列出", "查看目录"],
  grep: ["grep", "search in", "find text", "查找内容", "搜索内容", "包含", "关键词"],
  glob: ["find file", "glob", "查找文件", "匹配文件", "文件名", "模糊查找"],
  bash: ["bash", "shell", "terminal", "command", "终端", "命令", "cmd", "powershell"],
  code_exec: ["run", "execute", "python", "code", "运行", "执行", "代码", "脚本", "node"],
  web_search: ["search", "google", "find", "搜索", "查找", "互联网", "网络", "百度"],
  web_browse: ["browse", "browse", "浏览", "网页", "browser"],
  web_fetch: ["fetch", "url", "获取", "下载", "http"],
  git_status: ["git status", "git 状态", "版本控制状态"],
  git_diff: ["git diff", "git 差异", "代码差异"],
  git_log: ["git log", "git 历史", "提交历史"],
  git_commit: ["git commit", "git 提交", "提交代码"],
  lsp_definition: ["definition", "定义", "跳转到定义", "go to definition"],
  lsp_references: ["references", "引用", "查找引用", "find references"],
  lsp_hover: ["hover", "悬停", "hover info"],
  lsp_symbols: ["symbols", "符号", "符号大纲", "文件符号", "outline"],
  lsp_implementations: ["implementations", "实现", "查找实现", "implementations of"],
  lsp_rename: ["rename", "重命名", "改名", "renaming", "跨文件重命名"],
  memory_search: ["memory", "记忆", "搜索记忆"],
  memory_recall: ["recall", "召回", "回忆"],
  delegate_task: ["delegate", "委派", "子任务", "subtask"],
  task_planner: ["plan", "规划", "计划", "task"],
  workflow_run: ["workflow", "工作流", "编排"],
  image_gen: ["image", "图片", "生成图片", "image generation"],
  create_docx: ["docx", "word", "文档", "document"],
  search_history: ["history", "历史", "搜索历史"],
  question: ["question", "提问", "询问"],
  data_analysis: ["analysis", "分析", "数据分析"],
  team_tool: ["team", "团队", "协作"],
  cron_tool: ["cron", "定时", "scheduled"],
  worktree_tool: ["worktree", "工作树"],
}

interface ToolInfo {
  name: string
  description: string
  category: string
  keywords: string[]
}

// 工具描述缓存
let toolInfoCache: ToolInfo[] | null = null

function getToolInfoList(): ToolInfo[] {
  if (toolInfoCache) return toolInfoCache

  toolInfoCache = Object.entries(toolMetadata).map(([name, meta]) => ({
    name,
    description: getToolDescription(name),
    category: meta.category,
    keywords: TOOL_KEYWORDS[name] || [],
  }))

  return toolInfoCache
}

function getToolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    read_file: "读取文件内容或列出目录",
    write_file: "创建新文件或完全替换文件内容",
    edit_file: "编辑文件指定部分",
    list_files: "列出目录内容",
    grep: "正则内容搜索",
    glob: "文件名模式匹配",
    bash: "Shell 命令执行",
    code_exec: "代码执行",
    web_search: "网络搜索",
    web_browse: "网页浏览",
    web_fetch: "URL 内容获取",
    git_status: "Git 状态",
    git_diff: "Git 差异",
    git_log: "Git 提交历史",
    git_commit: "Git 提交",
    lsp_definition: "跳转到定义",
    lsp_references: "查找引用",
    lsp_hover: "悬停信息",
    lsp_symbols: "文件符号大纲",
    lsp_implementations: "查找实现",
    lsp_rename: "跨文件重命名",
    memory_search: "记忆搜索",
    memory_recall: "记忆召回",
    delegate_task: "任务委派给子 Agent",
    task_planner: "任务规划",
    workflow_run: "Dynamic Workflow 执行",
    image_gen: "AI 图片生成",
    create_docx: "Word 文档生成",
    search_history: "历史记录搜索",
    question: "向用户提问",
    data_analysis: "数据分析",
    team_tool: "团队协作工具",
    cron_tool: "定时任务调度",
    worktree_tool: "Git Worktree 管理",
  }
  return descriptions[name] || name
}

/**
 * 根据用户输入搜索相关工具
 * 使用简单的关键词匹配（参考 Claude Code 的 TF-IDF 思路）
 */
export function searchTools(query: string, maxResults = 10): ToolInfo[] {
  const tools = getToolInfoList()
  const lowerQuery = query.toLowerCase()

  // 计算每个工具的相关性得分
  const scored = tools.map(tool => {
    let score = 0

    // 关键词匹配
    for (const keyword of tool.keywords) {
      if (lowerQuery.includes(keyword.toLowerCase())) {
        score += 10
      }
    }

    // 工具名匹配
    if (lowerQuery.includes(tool.name)) {
      score += 20
    }

    // 类别匹配
    if (lowerQuery.includes(tool.category)) {
      score += 5
    }

    return { tool, score }
  })

  // 按得分排序，返回前 N 个
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.tool)
}

/**
 * 根据关键词获取推荐工具
 */
export function getRecommendedTools(keywords: string[]): string[] {
  const tools = getToolInfoList()
  const recommendations = new Set<string>()

  for (const keyword of keywords) {
    const lower = keyword.toLowerCase()
    for (const tool of tools) {
      if (tool.keywords.some(k => lower.includes(k))) {
        recommendations.add(tool.name)
      }
    }
  }

  return Array.from(recommendations)
}

/**
 * 检查工具是否应该加载
 * 基于上下文判断是否需要某个工具
 */
export function shouldLoadTool(toolName: string, context: {
  hasCode?: boolean
  hasFiles?: boolean
  hasGit?: boolean
  hasWeb?: boolean
  hasTerminal?: boolean
}): boolean {
  const meta = toolMetadata[toolName]
  if (!meta) return false

  // 基础工具始终加载
  if (meta.category === "core") return true

  // 根据上下文决定
  switch (meta.category) {
    case "knowledge":
      return context.hasWeb !== false
    case "execution":
      return context.hasTerminal !== false
    case "orchestration":
      return true // 编排工具始终可用
    case "infrastructure":
      return context.hasCode !== false
    default:
      return true
  }
}
