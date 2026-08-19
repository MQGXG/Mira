import { useState, useEffect, useRef, useMemo } from "react"
import { Search, FileText, FileEdit, Globe, Code, FolderOpen, Wrench, X, Terminal, Sparkles } from "lucide-react"
import type { ToolInfo, ToolResult } from "../services/agent.service"
import { AgentService } from "../services/agent.service"
import { Button } from "../components/ui/button"
import { Input } from "../components/ui/input"

interface Props {
  onResult: (toolName: string, result: ToolResult) => void
  disabled?: boolean
  inputHint?: string
}

const toolIcons: Record<string, typeof Search> = {
  read_file: FileText,
  write_file: FileEdit,
  list_files: FolderOpen,
  web_search: Globe,
  grep: Search,
  glob: Search,
  run_code: Code,
  bash: Terminal,
}

const toolKeywords: Record<string, string[]> = {
  read_file: ["read", "open", "查看", "读取", "打开", "show", "cat", "content", "文件内容", "看看", "显示"],
  write_file: ["write", "create", "save", "写入", "创建", "保存", "生成文件", "新建"],
  list_files: ["list", "ls", "dir", "directory", "文件夹", "目录", "列出", "查看目录", "有哪些文件"],
  web_search: ["search", "google", "find", "搜索", "查找", "互联网", "网络", "查一下", "搜一下", "百度"],
  grep: ["grep", "search in", "find text", "查找内容", "搜索内容", "包含", "关键词"],
  glob: ["find file", "glob", "查找文件", "匹配文件", "文件名", "模糊查找"],
  run_code: ["run", "execute", "python", "code", "运行", "执行", "代码", "脚本", "node"],
  edit_file: ["edit", "replace", "modify", "修改", "替换", "编辑", "改动", "更新"],
  bash: ["bash", "shell", "terminal", "command", "终端", "命令", "cmd", "powershell", "执行命令"],
}

const btnStyle = {
  color: 'var(--text-secondary)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontSize: 'inherit',
  fontFamily: 'inherit',
}

export function ToolPalette({ onResult, disabled, inputHint }: Props) {
  const [open, setOpen] = useState(false)
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [selectedTool, setSelectedTool] = useState<ToolInfo | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)
  const paletteRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) { AgentService.listTools().then(setTools) }
  }, [open])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (paletteRef.current && !paletteRef.current.contains(e.target as Node)) {
        setOpen(false); setSelectedTool(null); setResultMsg(null)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  const suggestedTool = useMemo(() => {
    if (!inputHint || open) return null
    const lower = inputHint.toLowerCase()
    for (const [toolName, keywords] of Object.entries(toolKeywords)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        return tools.find((t) => t.name === toolName) || null
      }
    }
    return null
  }, [inputHint, tools, open])

  const handleSelectTool = (tool: ToolInfo) => {
    setSelectedTool(tool); setResultMsg(null); setInputs({})
  }

  const handleExecute = async () => {
    if (!selectedTool) return
    setLoading(true); setResultMsg(null)
    try {
      const args: Record<string, unknown> = {}
      const props = selectedTool.parameters?.properties as Record<string, { type: string }> | undefined
      if (props) {
        for (const [key] of Object.entries(props)) {
          if (inputs[key] !== undefined && inputs[key] !== "") {
            args[key] = props[key].type === "number" ? Number(inputs[key]) : inputs[key]
          }
        }
      }
      const result = await AgentService.executeTool(selectedTool.name, args)
      onResult(selectedTool.name, result)
      if (result.success) {
        setResultMsg("✅ 执行成功，结果已添加到对话")
        setTimeout(() => { setOpen(false); setSelectedTool(null); setResultMsg(null) }, 1000)
      } else {
        setResultMsg(`❌ ${result.error || "执行失败"}`)
      }
    } catch (e) {
      onResult(selectedTool.name, { success: false, output: "", error: String(e) })
      setResultMsg(`❌ ${String(e)}`)
    } finally { setLoading(false) }
  }

  return (
    <div ref={paletteRef} className="relative">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} disabled={disabled}
        className="text-xs"
        style={{
          color: suggestedTool && !open ? 'var(--primary)' : 'var(--text-tertiary)',
          background: suggestedTool && !open ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'transparent',
          border: suggestedTool && !open ? '1px solid color-mix(in srgb, var(--primary) 20%, transparent)' : '1px solid transparent',
        }}
        title="工具面板 (可直接执行，不经过 LLM)">
        <Wrench className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">{suggestedTool ? suggestedTool.name : "工具"}</span>
      </Button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-80 rounded-xl overflow-hidden z-50"
          style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}>
          {resultMsg ? (
            <div className="p-4 text-sm text-center" style={{ color: 'var(--text-primary)' }}>{resultMsg}</div>
          ) : !selectedTool ? (
            <div>
              <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>工具面板</div>
                <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>直接执行，不需要 AI 参与</div>
              </div>
              <div className="max-h-72 overflow-y-auto scrollbar-custom p-1.5 space-y-0.5">
                {tools.map((tool) => {
                  const Icon = toolIcons[tool.name] || Wrench
                  const isSuggested = tool.name === suggestedTool?.name
                  return (
                    <button key={tool.name} onClick={() => handleSelectTool(tool)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left text-sm transition-all duration-200"
                      style={{
                        color: isSuggested ? 'var(--primary)' : 'var(--text-primary)',
                        background: isSuggested ? 'color-mix(in srgb, var(--primary) 10%, transparent)' : 'transparent',
                        border: isSuggested ? '1px solid color-mix(in srgb, var(--primary) 20%, transparent)' : 'none',
                      }}>
                      <Icon className="w-4 h-4 shrink-0" style={{ color: isSuggested ? 'var(--primary)' : 'var(--text-secondary)' }} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium truncate">{tool.name}</div>
                        <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>{tool.description}</div>
                      </div>
                      {isSuggested && <Sparkles className="w-3 h-3 shrink-0" style={{ color: 'var(--primary)' }} />}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {(() => { const Icon = toolIcons[selectedTool.name] || Wrench; return <Icon className="w-4 h-4" style={{ color: 'var(--primary)' }} /> })()}
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{selectedTool.name}</span>
                </div>
                <button onClick={() => setSelectedTool(null)} className="p-1.5 rounded-lg transition-colors hover:bg-muted">
                  <X className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)' }} />
                </button>
              </div>

              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{selectedTool.description}</p>

              {!!selectedTool.parameters?.properties && (
                <div className="space-y-2.5">
                  {Object.entries(selectedTool.parameters.properties as Record<string, { type: string; description?: string }>).map(([key, prop]) => {
                    const required = (selectedTool.parameters?.required || []) as string[]
                    return (
                      <div key={key}>
                        <label className="text-xs block mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                          {key}{required.includes(key) && <span className="ml-1" style={{ color: 'var(--destructive)' }}>*</span>}
                        </label>
                        <Input
                          type={prop.type === "number" ? "number" : "text"}
                          value={inputs[key] || ""}
                          onChange={(e) => setInputs((p) => ({ ...p, [key]: e.target.value }))}
                          placeholder={prop.description || key}
                          className="rounded-xl"
                        />
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button onClick={handleExecute} disabled={loading}
                  className="flex-1">
                  {loading ? "执行中..." : "执行"}
                </Button>
                <Button variant="ghost" onClick={() => setSelectedTool(null)}
                  className="flex-1 text-secondary">
                  返回
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
