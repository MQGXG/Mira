/**
 * 斜杠命令定义 — 内置动作命令 + 工具/内容型发消息命令
 *
 * 技能命令由 ChatWindow 从 AgentService.listSkills() 动态生成，与之合并展示。
 */

export type SlashCommandSource = "builtin" | "tool" | "skill"

export interface SlashCommandDef {
  id: string
  trigger: string
  label: string
  description: string
  category: string
  source: SlashCommandSource
  /** 动作命令直接操作 UI；发消息命令填入引导文本后发送 */
  action: () => void
}

export interface SlashCommandDeps {
  currentMode: string
  onModeChange: (mode: string) => void
  onNewSession?: () => void
  clearMessages: () => void
  sendMessage: (text: string) => void
  setGoalCondition: (v: string | null) => void
  setTheme: (theme: "light" | "dark" | "system") => void
  openHelp?: () => void
}

const MODE_ORDER = ["assistant", "expert", "action", "safe", "plan"]

export function buildBuiltinCommands(deps: SlashCommandDeps): SlashCommandDef[] {
  return [
    // ── 会话 ───────────────────────────────────────────
    {
      id: "clear", trigger: "clear", label: "清空会话", description: "清空当前对话内容",
      category: "会话", source: "builtin", action: () => deps.clearMessages(),
    },
    {
      id: "new", trigger: "new", label: "新建会话", description: "开启一个新对话",
      category: "会话", source: "builtin", action: () => deps.onNewSession?.(),
    },

    // ── Agent / 模型 ───────────────────────────────────
    {
      id: "mode", trigger: "mode", label: "切换模式", description: "循环切换 助手/专家/执行/安全/规划",
      category: "Agent", source: "builtin",
      action: () => {
        const i = MODE_ORDER.indexOf(deps.currentMode)
        deps.onModeChange(MODE_ORDER[(i + 1) % MODE_ORDER.length])
      },
    },

    // ── 界面 / 主题 ────────────────────────────────────
    {
      id: "dark", trigger: "dark", label: "深色模式", description: "切换到深色主题",
      category: "界面", source: "builtin", action: () => deps.setTheme("dark"),
    },
    {
      id: "light", trigger: "light", label: "浅色模式", description: "切换到浅色主题",
      category: "界面", source: "builtin", action: () => deps.setTheme("light"),
    },
    {
      id: "theme", trigger: "theme", label: "跟随系统", description: "主题跟随系统设置",
      category: "界面", source: "builtin", action: () => deps.setTheme("system"),
    },

    // ── 任务 ───────────────────────────────────────────
    {
      id: "goal", trigger: "goal", label: "清除目标", description: "清除当前任务目标",
      category: "任务", source: "builtin", action: () => deps.setGoalCondition(null),
    },

    // ── 内容类（发消息型，引导 AI）────────────────────
    {
      id: "summarize", trigger: "总结", label: "总结对话", description: "让 AI 总结当前对话要点",
      category: "内容", source: "tool",
      action: () => deps.sendMessage("请总结我们当前对话的内容，列出关键要点和结论。"),
    },
    {
      id: "translate", trigger: "翻译", label: "翻译", description: "让 AI 翻译文本",
      category: "内容", source: "tool", action: () => deps.sendMessage("请帮我翻译："),
    },
    {
      id: "explain", trigger: "解释代码", label: "解释代码", description: "让 AI 解释代码逻辑",
      category: "内容", source: "tool", action: () => deps.sendMessage("请解释一下这段代码："),
    },
    {
      id: "optimize", trigger: "优化代码", label: "优化代码", description: "让 AI 优化重构代码",
      category: "内容", source: "tool", action: () => deps.sendMessage("请帮我优化这段代码："),
    },
    {
      id: "search", trigger: "搜索", label: "网页搜索", description: "让 AI 搜索最新信息",
      category: "内容", source: "tool", action: () => deps.sendMessage("请搜索："),
    },
    {
      id: "report", trigger: "写报告", label: "写报告", description: "让 AI 生成一份报告",
      category: "内容", source: "tool", action: () => deps.sendMessage("请帮我写一份报告："),
    },

    // ── 工具类（发消息型，引导已有工具）───────────────
    {
      id: "docx", trigger: "docx", label: "Word 文档", description: "让 AI 创建 Word 文档",
      category: "工具", source: "tool", action: () => deps.sendMessage("请帮我创建一个 Word 文档："),
    },
    {
      id: "image", trigger: "图片生成", label: "生成图片", description: "让 AI 生成图片",
      category: "工具", source: "tool", action: () => deps.sendMessage("请帮我生成一张图片："),
    },
    {
      id: "analyze", trigger: "数据分析", label: "数据分析", description: "让 AI 分析数据",
      category: "工具", source: "tool", action: () => deps.sendMessage("请帮我分析："),
    },

    // ── 系统 ───────────────────────────────────────────
    {
      id: "help", trigger: "help", label: "帮助", description: "显示可用命令帮助",
      category: "系统", source: "builtin", action: () => deps.openHelp?.(),
    },
  ]
}

/** 来源徽标文案 */
export const SOURCE_LABEL: Record<SlashCommandSource, string> = {
  builtin: "内置",
  tool: "工具",
  skill: "技能",
}
