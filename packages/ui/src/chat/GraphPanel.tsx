/**
 * GraphPanel — 图运行轨迹面板
 * 展示编码任务图的节点执行轨迹（research → implement → test → review → done）
 * 通过 GraphService 启动运行，并监听 graph 事件流实时更新
 */

import { useEffect, useRef, useState } from "react"
import { GraphService, type GraphResult } from "../services/graph.service"
import { ProjectService } from "../services/project.service"
import { getProviderById } from "../sidebar/provider-data"

interface GraphEvent {
  type: "graph_event"
  event: {
    type: string
    node?: string
    nodeId?: string
    [key: string]: unknown
  }
}

interface NodeTrace {
  node: string
  status: "pending" | "running" | "passed" | "failed" | "completed" | "rejected" | "approved"
  output?: string
  usage?: number
}

const NODE_LABELS: Record<string, string> = {
  research: "需求调研",
  implement: "实现/修改",
  fix: "修复问题",
  test: "测试/校验",
  review: "代码审查",
  done: "汇总交付",
}

export function GraphPanel({ workspace, config }: { workspace?: string; config: Record<string, unknown> }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [traces, setTraces] = useState<Record<string, NodeTrace>>({})
  const [result, setResult] = useState<GraphResult | null>(null)
  const [request, setRequest] = useState("")
  const cleanupRef = useRef<(() => void) | null>(null)
  const resolvedWorkspace = useRef<string | undefined>(workspace)

  // workspace 未传入时，取第一个项目的工作区
  useEffect(() => {
    if (resolvedWorkspace.current) return
    ProjectService.list().then((projects) => {
      const ws = projects[0]?.workspace_path
      if (ws) resolvedWorkspace.current = ws
    }).catch(() => {})
  }, [])

  const addTrace = (node: string, partial: Partial<NodeTrace>) => {
    setTraces((prev) => ({
      ...prev,
      [node]: { ...partial, node, status: partial.status ?? prev[node]?.status ?? "pending" },
    }))
  }

  const handleEvent = (data: GraphEvent) => {
    const ev = data?.event
    if (!ev || typeof ev !== "object") return
    const node = (ev as { node?: string }).node || (ev as { nodeId?: string }).nodeId
    if (!node) return
    const evType = (ev as { type?: string }).type
    switch (evType) {
      case "node_start":
        addTrace(node, { status: "running" })
        break
      case "node_result": {
        const verdict = (ev as { verdict?: string }).verdict
        const passed = (ev as { passed?: boolean }).passed
        const rawOutput = (ev as { output?: unknown }).output
        const rawUsage = (ev as { usage?: unknown }).usage
        addTrace(node, {
          status: verdict === "approved" ? "approved" : verdict === "rejected" ? "rejected" : passed === false ? "failed" : "completed",
          output: typeof rawOutput === "string" ? rawOutput : undefined,
          usage: typeof rawUsage === "number" ? rawUsage : undefined,
        })
        break
      }
    }
  }

  const start = async () => {
    if (!request.trim() || running) return
    setRunning(true)
    setTraces({})
    setResult(null)
    try {
      // 补全 Provider 的 apiKey / apiUrl
      const provider = await getProviderById(config.provider as string).catch(() => null)
      const fullConfig = {
        ...config,
        apiKey: provider?.apiKey || (config.apiKey as string) || "",
        apiUrl: provider?.apiUrl || (config.apiUrl as string) || "",
        headers: provider?.headers || {},
        workspace: resolvedWorkspace.current || workspace || config.workspace,
        sessionID: config.sessionID || `graph-${Date.now()}`,
      }
      const { runId: id } = await GraphService.runCodingTask(request, fullConfig)
      setRunId(id)
      const cleanup = window.electronAPI.agent.onEvent(`graph-${id}`, (data) => {
        if (!data || typeof data !== "object") return
        const kind = (data as { type?: string }).type
        if (kind === "graph_result") {
          setResult(data as GraphResult)
          setRunning(false)
          setRunId(null)
        } else if (kind === "graph_event") {
          handleEvent(data as GraphEvent)
        }
      })
      cleanupRef.current = cleanup
    } catch (err) {
      console.error("Graph run failed:", err)
      setRunning(false)
    }
  }

  const stop = () => {
    if (runId) void GraphService.stop(runId)
    setRunning(false)
    setRunId(null)
  }

  useEffect(() => () => {
    cleanupRef.current?.()
  }, [])

  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-zinc-700 dark:text-zinc-200">编码任务图</h3>
        {running && (
          <button onClick={stop} className="text-xs text-red-500 hover:underline">
            停止
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void start() }}
          placeholder="描述编码任务…"
          className="flex-1 rounded-md border border-zinc-200 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700"
        />
        <button
          onClick={() => { void start() }}
          disabled={running || !request.trim()}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {running ? "运行中…" : "运行"}
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {Object.entries(traces).length === 0 && !running && !result && (
          <div className="text-center text-xs text-zinc-400">
            输入任务后运行，节点轨迹将实时展示
          </div>
        )}
        {Object.entries(traces).map(([nodeId, trace]) => (
          <div
            key={nodeId}
            className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-700"
          >
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                trace.status === "running"
                  ? "animate-pulse bg-blue-500"
                  : trace.status === "passed" || trace.status === "approved" || trace.status === "completed"
                    ? "bg-emerald-500"
                    : trace.status === "failed" || trace.status === "rejected"
                      ? "bg-red-500"
                      : "bg-zinc-300 dark:bg-zinc-600"
              }`}
            />
            <span className="font-medium text-zinc-700 dark:text-zinc-200">
              {NODE_LABELS[nodeId] || nodeId}
            </span>
            {trace.usage !== undefined && trace.usage > 0 && (
              <span className="text-xs text-zinc-400">{trace.usage} tok</span>
            )}
            {trace.output && (
              <span className="ml-auto max-w-[40%] truncate text-xs text-zinc-400" title={trace.output}>
                {trace.output}
              </span>
            )}
          </div>
        ))}
      </div>

      {result && (
        <div className="rounded-md border border-zinc-200 p-3 text-xs dark:border-zinc-700">
          <div className="mb-1 font-semibold text-zinc-700 dark:text-zinc-200">
            运行结果：{result.status}
            {result.totalTokens > 0 && <span className="ml-2 font-normal text-zinc-400">{result.totalTokens} tok</span>}
          </div>
          <div className="text-zinc-500">节点顺序：{result.visited.join(" → ")}</div>
          {result.error && <div className="mt-1 text-red-500">错误：{result.error}</div>}
        </div>
      )}
    </div>
  )
}
