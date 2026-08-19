/**
 * 语音对话按钮 — 实时语音对话入口（主聊天窗口）
 *
 * 点击开始：VAD 监听 → 说话 → Whisper 识别 → 回调发送给 Agent；
 * Agent 回复文本变化时自动 TTS 朗读。
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { PhoneCall, PhoneOff, Loader2 } from "lucide-react"
import { RealtimeVoice, type RealtimeStatus } from "../services/voice/realtime-voice"
import { getTTSEngine, getDictationEngine } from "../services/voice/engine-registry"
import { loadSettings } from "../sidebar/provider-data"

interface VoiceChatButtonProps {
  /** 用户语音识别后发送给 Agent */
  onSendMessage: (text: string) => void
  /** 最新一条助手回复文本（用于自动朗读） */
  assistantText?: string
  /** 对话状态变化（供外部驱动口型等） */
  onStatusChange?: (status: RealtimeStatus) => void
  disabled?: boolean
  className?: string
}

export function VoiceChatButton({ onSendMessage, assistantText, onStatusChange, disabled = false, className = "" }: VoiceChatButtonProps) {
  const [active, setActive] = useState(false)
  const [status, setStatus] = useState<RealtimeStatus>("idle")
  const voiceRef = useRef<RealtimeVoice | null>(null)
  const lastSpokenRef = useRef("")

  const handleStatus = useCallback((s: RealtimeStatus) => {
    setStatus(s)
    onStatusChange?.(s)
  }, [onStatusChange])

  const ensureVoice = useCallback(async (): Promise<RealtimeVoice> => {
    if (voiceRef.current) return voiceRef.current
    // 引擎来自目录（voice.json 默认选中 + 内置/用户/插件注册）
    const tts = await getTTSEngine()
    const stt = await getDictationEngine()
    voiceRef.current = new RealtimeVoice({
      tts,
      transcribe: async (audio) => {
        const text = typeof stt.transcribe === "function" ? await stt.transcribe(audio) : undefined
        return text ?? ""
      },
      onUserSpeech: (text) => { void onSendMessage(text) },
      onStatusChange: handleStatus,
    })
    return voiceRef.current
  }, [handleStatus, onSendMessage])

  const toggle = useCallback(async () => {
    if (disabled) return
    if (active) {
      voiceRef.current?.stop()
      setActive(false)
    } else {
      try {
        await (await ensureVoice()).start()
        setActive(true)
      } catch (err) {
        console.error("[voice] 启动语音对话失败:", err)
      }
    }
  }, [active, disabled, ensureVoice])

  // 监听最新助手回复 → 自动朗读
  useEffect(() => {
    if (active && assistantText && assistantText !== lastSpokenRef.current) {
      lastSpokenRef.current = assistantText
      void voiceRef.current?.speak(assistantText)
    }
  }, [assistantText, active])

  useEffect(() => () => { voiceRef.current?.stop() }, [])

  const statusLabel =
    status === "speaking" ? "朗读中" : status === "processing" ? "识别中" : status === "listening" ? "聆听中" : active ? "对话中" : "语音对话"

  // 设置开关：关闭时隐藏（hooks 已全部执行，条件只影响渲染）
  if (loadSettings().voiceChatEnabled === false) return null;

  return (
    <button
      onClick={toggle}
      disabled={disabled}
      title={statusLabel}
      className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all duration-200 ${className}`}
      style={{
        color: active ? "var(--success)" : "var(--text-tertiary)",
        background: active ? "color-mix(in srgb, var(--success) 10%, transparent)" : "transparent",
      }}
    >
      {status === "processing" || status === "speaking" ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : active ? (
        // 对话进行中：显示"挂断"图标（点击即停止）
        <PhoneOff className="w-4 h-4" />
      ) : (
        // 未开始：显示"拨号/通话"图标（点击即开始语音对话）
        <PhoneCall className="w-4 h-4" />
      )}
      {active && status !== "processing" && status !== "speaking" && (
        <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--success)" }} />
      )}
    </button>
  )
}
