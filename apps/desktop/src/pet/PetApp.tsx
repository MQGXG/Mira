import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import { SpeechBubble } from "./SpeechBubble"
import { ChatInput } from "./ChatInput"
import { VoiceChatButton, type RealtimeStatus, LipSyncEngine, PetMotionManager, defaultPetPlugins } from "@mira/ui"

declare global {
  interface Window {
    Live2DCubismCore?: any
  }
}

declare module "react" {
  interface CSSProperties {
    WebkitAppRegion?: string
  }
}

interface PointLike { x: number; y: number }
type Live2DModelHandle = import("pixi.js").Container & {
  anchor: { set(x?: number, y?: number): void }
  focus?(x: number, y: number): void
  internalModel?: {
    coreModel?: {
      _model?: { parameters?: { ids?: string[] } }
      setParameterValueByIndex?(index: number, value: number, weight?: number): void
    }
  }
}

function setParameterByName(model: Live2DModelHandle | null, name: string, value: number): void {
  const coreModel = model?.internalModel?.coreModel
  if (!coreModel || typeof coreModel.setParameterValueByIndex !== "function") return
  try {
    const ids = coreModel._model?.parameters?.ids
    if (!ids) return
    const index = ids.indexOf(name)
    if (index >= 0) coreModel.setParameterValueByIndex(index, value)
  } catch {
    /* 引擎内部状态变化时忽略，避免影响聊天流程 */
  }
}

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
}

let msgCounter = 0

function getModels(): Record<string, string> {
  try {
    const stored = localStorage.getItem("pet_models")
    const raw: Record<string, string> = stored ? JSON.parse(stored) : { hiyori: "./models/hiyori/Hiyori.model3.json" }
    // 迁移：将旧版绝对路径 /models/... 转为相对路径 ./models/...
    let migrated = false
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.startsWith("/models/")) {
        raw[k] = "." + v
        migrated = true
      }
    }
    if (migrated) localStorage.setItem("pet_models", JSON.stringify(raw))
    return raw
  } catch { return { hiyori: "./models/hiyori/Hiyori.model3.json" } }
}

export function PetApp() {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<RealtimeStatus>("idle")
  const [live2dStatus, setLive2dStatus] = useState<string>("loading")
  const [live2dError, setLive2dError] = useState<string | null>(null)
  const [currentModel, setCurrentModel] = useState(0)
  const sessionRef = useRef<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const streamCleanupRef = useRef<(() => void) | null>(null)
  const modelRef = useRef<Live2DModelHandle | null>(null)
  const appRef = useRef<any>(null)
  const loadModelRef = useRef<((modelKey?: string) => Promise<void>) | null>(null)
  // 动作管理器引用：供事件回调触发情绪动作
  const motionRef = useRef<PetMotionManager | null>(null)

  // 口型联动 + 动作系统：统一 rAF 驱动
  //  - LipSyncEngine 在说话期独占 ParamMouthOpenY（响度驱动）
  //  - PetMotionManager 驱动其余参数（眨眼/呼吸/情绪动作），mouth 仅在非说话期回写
  const voiceStatusRef = useRef<RealtimeStatus>(voiceStatus)
  useEffect(() => { voiceStatusRef.current = voiceStatus }, [voiceStatus])
  useEffect(() => {
    const lipSync = new LipSyncEngine({ cap: 0.9, idleMs: 120 })
    const motion = new PetMotionManager({ idleIntervalMs: 16 })
    for (const plugin of defaultPetPlugins()) motion.register(plugin)
    // motion 负责 mouth 外的参数；呼吸/表情的 mouth 写到 shadowMap 待说话期后回写
    const shadow: Record<string, number> = {}
    motion.setSink((name, value) => { shadow[name] = value })
    motionRef.current = motion
    let raf = 0
    let breathT = 0
    let lastNow = 0
    const targetVolume = (status: RealtimeStatus): number =>
      status === "listening" || status === "speaking" ? 0.55 : 0

    const tick = (now: number) => {
      const dtSec = lastNow === 0 ? 0.016 : Math.min(0.1, (now - lastNow) / 1000)
      lastNow = now
      breathT += dtSec
      const breath = 0.04 + 0.03 * Math.sin(breathT * 2.2)
      const vol = Math.min(1, targetVolume(voiceStatusRef.current) + breath)
      const out = lipSync.update({ volume: vol, timeMs: now })

      motion.update(Math.max(0.001, dtSec))
      const speaking = voiceStatusRef.current === "listening" || voiceStatusRef.current === "speaking"
      // 非 mouth 参数直接回写；说话时 mouth 由 lip-sync 独占
      for (const [name, value] of Object.entries(shadow)) {
        if (speaking && name === "ParamMouthOpenY") continue
        setParameterByName(modelRef.current, name, value)
      }
      if (speaking && out.mouthOpen !== 0) {
        setParameterByName(modelRef.current, "ParamMouthOpenY", out.mouthOpen)
      } else if (!speaking && shadow.ParamMouthOpenY !== undefined) {
        // 说话结束：使用动作系统提供的 mouth（呼吸微幅），无则由 lipSync 归零
        setParameterByName(modelRef.current, "ParamMouthOpenY", shadow.ParamMouthOpenY)
      } else if (!speaking) {
        setParameterByName(modelRef.current, "ParamMouthOpenY", 0)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // 语音对话自动朗读的助手文本：仅在回复完成后提供（避免流式中间态反复朗读）
  const assistantText = useMemo(() => {
    if (streaming) return ""
    const last = messages[messages.length - 1]
    if (last?.role !== "assistant") return ""
    return last.content
  }, [messages, streaming])

  const addMsg = useCallback((role: "user" | "assistant", content: string) => {
    const id = ++msgCounter + ""
    setMessages((prev) => [...prev, { id, role, content }])
  }, [])

  const updateLastMsg = useCallback((updater: string | ((prev: string) => string)) => {
    setMessages((prev) => {
      if (prev.length === 0) return prev
      const copy = [...prev]
      const current = copy[copy.length - 1].content
      copy[copy.length - 1] = {
        ...copy[copy.length - 1],
        content: typeof updater === "function" ? updater(current) : updater,
      }
      return copy
    })
  }, [])

  useEffect(() => {
    const wrap = canvasWrapRef.current
    if (!wrap) return

    let destroyed = false

    const initLive2D = async () => {
      try {
        setLive2dStatus("loading Cubism Core...")
        if (!(window as any).Live2DCubismCore) {
          const loaded = await new Promise<boolean>((resolve) => {
            const s = document.createElement("script")
            s.src = "./Core/live2dcubismcore.min.js"
            s.onload = () => resolve(!!(window as any).Live2DCubismCore)
            s.onerror = () => resolve(false)
            document.head.appendChild(s)
          })
          if (!loaded) { setLive2dError("Cubism Core load failed"); setLive2dStatus("error"); return }
        }

        setLive2dStatus("importing...")
        const { Application, extensions } = await import("pixi.js")
        const { Live2DModel, Live2DPlugin } = await import("untitled-pixi-live2d-engine/cubism")
        extensions.add(Live2DPlugin)

        setLive2dStatus("creating canvas...")
        const app = new Application()
        await app.init({
          backgroundAlpha: 0,
          autoDensity: true,
          resolution: Math.max(window.devicePixelRatio || 1, 1),
          resizeTo: wrap,
          preference: "webgl",
        })
        app.canvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%"
        wrap.appendChild(app.canvas)
        if (destroyed) { app.destroy(true); return }

        setLive2dStatus("loading model...")
        appRef.current = app

        let ro: ResizeObserver | null = null
        let onWheel: ((e: WheelEvent) => void) | null = null

        const loadLive2DModel = async (modelKey?: string) => {
          const models = getModels()
          const key = modelKey ?? localStorage.getItem("pet_model") ?? "hiyori"
          const path = models[key] ?? Object.values(models)[0]
          setLive2dStatus(`loading ${key}...`)
          const m = await (Live2DModel as unknown as { from(path: string): Promise<Live2DModelHandle> }).from(path)
          modelRef.current?.destroy()
          modelRef.current = m
          app.stage.addChild(m)
          m.anchor.set(0.5)

          const fit = () => {
            const cw = app.canvas.clientWidth
            const ch = app.canvas.clientHeight
            if (cw <= 0 || ch <= 0) return
            const bounds = m.getLocalBounds()
            const modelSize = Math.max(bounds.width, bounds.height)
            if (modelSize > 0) m.scale.set(Math.min(cw, ch) * 1.2 / modelSize)
            m.position.set(cw / 2, ch / 2)
          }
          fit()

          ro?.disconnect()
          if (onWheel) app.canvas.removeEventListener("wheel", onWheel)
          app.stage.off("pointermove")
          app.stage.off("pointerup")
          app.stage.off("pointerupoutside")

          ro = new ResizeObserver(() => {
            const cw = app.canvas.clientWidth
            const ch = app.canvas.clientHeight
            if (cw <= 0 || ch <= 0) return
            const bounds = m.getLocalBounds()
            const modelSize = Math.max(bounds.width, bounds.height)
            if (modelSize > 0) m.scale.set(Math.min(cw, ch) * 1.2 / modelSize)
            m.position.set(cw / 2, ch / 2)
          })
          ro.observe(wrap)

          onWheel = (e: WheelEvent) => {
            e.preventDefault()
            const zoom = e.deltaY > 0 ? 0.9 : 1.1
            m.scale.set(m.scale.x * zoom)
          }
          app.canvas.addEventListener("wheel", onWheel, { passive: false })

          app.stage.eventMode = "static"
          let dragging = false
          let dragOffset = { x: 0, y: 0 }

          app.stage.on("pointermove", (e: { global: PointLike }) => {
            const pos = e.global
            if (dragging) m.position.set(pos.x - dragOffset.x, pos.y - dragOffset.y)
            m.focus?.(m.toLocal(pos).x, m.toLocal(pos).y)
          })

          m.eventMode = "static"
          m.cursor = "pointer"
          m.on("pointerdown", (e: any) => {
            dragging = true
            const pos = e.global
            dragOffset = { x: pos.x - m.position.x, y: pos.y - m.position.y }
          })

          app.stage.on("pointerup", () => { dragging = false })
          app.stage.on("pointerupoutside", () => { dragging = false })

          loadModelRef.current = loadLive2DModel
          setLive2dStatus("ready")
        }
        loadModelRef.current = loadLive2DModel
        await loadLive2DModel()
        const onStorage = (e: StorageEvent) => {
          if (e.key === "pet_model") loadLive2DModel(e.newValue ?? undefined)
        }
        window.addEventListener("storage", onStorage)
        const origCleanup = cleanupRef.current
        cleanupRef.current = () => {
          window.removeEventListener("storage", onStorage)
          if (onWheel) app.canvas.removeEventListener("wheel", onWheel)
          app.stage.off("pointermove")
          app.stage.off("pointerup")
          app.stage.off("pointerupoutside")
          ro?.disconnect()
          modelRef.current = null
          app.destroy(true, { children: true, texture: true })
        }

      } catch (err: unknown) {
        console.error("[Pet] Live2D init FAILED:", err)
        setLive2dError((err instanceof Error ? err.message : String(err)) || String(err))
        setLive2dStatus("error")
      }
    }

    initLive2D()

    return () => {
      destroyed = true
      streamCleanupRef.current?.()
      cleanupRef.current?.()
    }
  }, [])

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return
      setStreaming(true)
      addMsg("user", text)
      motionRef.current?.trigger({ kind: "nod", durationMs: 600 })

      try {
        if (!sessionRef.current) {
          const projects = await window.electronAPI.ts.listProjects()
          let petProject = projects.find((p: any) => p.name === "Live2D Pet")
          if (!petProject) {
            const created = await window.electronAPI.ts.createProject("Live2D Pet", "")
            petProject = { project_id: created.project_id, name: "Live2D Pet", workspace_path: "" }
          }
          const session = await window.electronAPI.ts.createSession(petProject.project_id, "Pet Chat")
          sessionRef.current = session.session_id
        }

        const config = await window.electronAPI.config.get()
        addMsg("assistant", "")

        const channel = await window.electronAPI.agent.startStream(
          sessionRef.current, text, config || {}
        )

        const cleanup = window.electronAPI.agent.onEvent(channel, (data: any) => {
          if (data.type === "content" && data.text) {
            updateLastMsg((prev: string) => prev + data.text)
            motionRef.current?.trigger({ kind: "joy", durationMs: 900 })
          } else if (data.type === "finish") {
            setStreaming(false)
            motionRef.current?.trigger({ kind: "joy", durationMs: 700 })
          } else if (data.type === "error") {
            updateLastMsg((prev: string) => prev || `Error: ${data.message}`)
            setStreaming(false)
            motionRef.current?.trigger({ kind: "sad", durationMs: 900 })
          }
        })
        streamCleanupRef.current = cleanup
      } catch (err: any) {
        updateLastMsg(`[Error] ${err.message || "Failed to send message"}`)
        setStreaming(false)
      }
    },
    [streaming, addMsg, updateLastMsg]
  )

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%", height: "100%", display: "flex", flexDirection: "column",
      }}
    >
      <div style={{
        height: 32, WebkitAppRegion: "drag", cursor: "grab", flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(15,15,20,0.6)",
      }}>
        <div style={{ width: 40, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.15)" }} />
      </div>
      <div
        ref={canvasWrapRef}
        style={{
          flex: 1, position: "relative", minHeight: 100,
          WebkitAppRegion: "no-drag",
        }}
      >
        {live2dStatus !== "ready" && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,0.6)", color: live2dError ? "var(--error)" : "var(--muted-foreground)",
            fontSize: 11, textAlign: "center", padding: 12, zIndex: 10, pointerEvents: "none",
          }}>
            {live2dError
              ? <><div style={{ fontSize: 18, marginBottom: 6 }}>&#9888;</div><div>{live2dError}</div></>
              : <div>{live2dStatus}</div>
            }
          </div>
        )}
      </div>

      <div style={{
        WebkitAppRegion: "no-drag", background: "var(--card)",
        backdropFilter: "blur(12px)", borderTop: "1px solid var(--border)",
        padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, maxHeight: "45%",
      }}>
        <div style={{
          display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", flex: 1, minHeight: 0,
        }}>
          {messages.map((msg) => (
            <SpeechBubble key={msg.id} role={msg.role} content={msg.content} />
          ))}
        </div>
        <ChatInput onSend={handleSend} disabled={streaming} />
        <VoiceChatButton
          onSendMessage={(text) => { void handleSend(text) }}
          assistantText={assistantText}
          onStatusChange={setVoiceStatus}
          className="self-end"
        />
      </div>
    </div>
  )
}
