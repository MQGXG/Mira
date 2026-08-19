/**
 * DynamicPluginHost — 渲染进程 client half 执行器
 *
 * 拉取动态插件的 client 代码，在沙箱中求值（new Function，仅执行插件自身逻辑），
 * 调用 render() 将结果注入容器。用于"一切皆插件"的 UI 插件展示。
 *
 * client 代码约定：async 函数体 return 插件对象，其中 render() 返回 HTML 字符串
 * 或 HTMLElement。代码不持有真实 window/DOM 访问（由宿主注入容器）。
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { getSelfModClientCode } from "../services/selfmod.service"

export interface DynamicPluginHostProps {
  sessionId: string
  pluginId: string
  packageId?: string
  /** 渲染失败/拉取失败时的降级展示 */
  fallback?: React.ReactNode
  className?: string
}

/**
 * Web Worker 沙箱执行 client 代码（隔离 window/document/全局，强化安全性）。
 * worker 内执行插件代码 → 调用 render() → postMessage 返回结果（HTML 字符串/对象）。
 * 主线程把结果注入容器。worker 不可用时降级到 new Function（同 realm，隔离较弱）。
 */
async function evaluateClientCodeInWorker(code: string): Promise<{ render?: () => unknown }> {
  if (typeof Worker === "undefined") {
    // eslint-disable-next-line no-new-func
    const factory = new Function(`return (async () => {\n${code}\n})()`)
    const plugin = await factory()
    return (plugin ?? {}) as { render?: () => unknown }
  }
  const workerSource = `
    self.onmessage = async (e) => {
      try {
        const fn = new Function('return (async () => {\\n' + e.data.code + '\\n})()')
        const plugin = await fn()
        const result = (plugin && typeof plugin.render === 'function') ? await plugin.render() : null
        self.postMessage({ ok: true, result })
      } catch (err) {
        self.postMessage({ ok: false, error: String(err && err.message ? err.message : err) })
      }
    }
  `
  const url = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }))
  const worker = new Worker(url)
  try {
    const result: unknown = await new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const data = e.data as { ok: boolean; result?: unknown; error?: string }
        if (data.ok) resolve(data.result)
        else reject(new Error(data.error || "client 插件执行失败"))
      }
      worker.onerror = (err) => reject(new Error(err.message || "worker 错误"))
      worker.postMessage({ code })
    })
    return { render: () => result }
  } finally {
    worker.terminate()
    URL.revokeObjectURL(url)
  }
}

function injectRenderResult(container: HTMLElement, result: unknown): void {
  if (typeof result === "string") {
    container.innerHTML = result
  } else if (result instanceof HTMLElement) {
    container.innerHTML = ""
    container.appendChild(result)
  } else if (result && typeof result === "object" && "html" in result) {
    container.innerHTML = String((result as { html: unknown }).html)
  }
}

export function DynamicPluginHost({ sessionId, pluginId, packageId, fallback, className }: DynamicPluginHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading")
  const [error, setError] = useState<string>("")

  const load = useCallback(async () => {
    setStatus("loading")
    setError("")
    const result = await getSelfModClientCode(sessionId, pluginId, packageId)
    if (!result.ok) {
      setStatus("error")
      setError(result.error || "client 代码拉取失败")
      return
    }
    try {
      const plugin = await evaluateClientCodeInWorker(result.clientCode || "")
      const container = containerRef.current
      if (!container) return
      const renderResult = plugin.render?.()
      injectRenderResult(container, renderResult)
      setStatus("ok")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [sessionId, pluginId, packageId])

  useEffect(() => {
    void load()
    return () => {
      if (containerRef.current) containerRef.current.innerHTML = ""
    }
  }, [load])

  if (status === "error") {
    return <div className={className} style={{ padding: 8, color: "#ef4444", fontSize: 12 }}>{fallback ?? error}</div>
  }
  return (
    <div className={className} style={{ position: "relative" }}>
      {status === "loading" && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, opacity: 0.6 }}>
          插件 UI 加载中…
        </div>
      )}
      <div ref={containerRef} style={{ minHeight: status === "loading" ? 48 : undefined }} />
    </div>
  )
}
