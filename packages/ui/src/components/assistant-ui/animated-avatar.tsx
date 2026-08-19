"use client";

/**
 * AnimatedAvatar — 动态头像
 * 支持状态切换：idle / thinking / speaking / error
 * 默认使用 AI.gif（动态头像），用户可在设置中自定义头像图。
 */

import { useMemo, useState, useEffect } from "react"
import { cn } from "../../lib/utils"
import defaultAvatarGif from "../../assets/AI.gif"

export type AvatarState = "idle" | "thinking" | "speaking" | "error"

interface AnimatedAvatarProps {
  src?: string
  state?: AvatarState
  size?: number
  className?: string
}

/** 默认头像（AI.gif，Vite 打包为资源） */
const DEFAULT_AVATAR = defaultAvatarGif

function getAvatarSrc(): string {
  try {
    const settings = JSON.parse(localStorage.getItem("settings") || "{}") as { avatarPath?: string }
    return settings.avatarPath || ""
  } catch { return "" }
}

export function AnimatedAvatar({ src, state = "idle", size = 48, className }: AnimatedAvatarProps) {
  const [savedSrc, setSavedSrc] = useState("")

  useEffect(() => {
    setSavedSrc(getAvatarSrc())
  }, [])

  // 优先级：显式传入 > 用户设置 > 默认 AI.gif
  const finalSrc = src || savedSrc || DEFAULT_AVATAR

  const stateClass = useMemo(() => ({
    idle: "avatar-idle",
    thinking: "avatar-thinking",
    speaking: "avatar-speaking",
    error: "avatar-error",
  }[state]), [state])

  return (
    <div
      className={cn("animated-avatar relative shrink-0", stateClass, className)}
      style={{ width: size, height: size }}
    >
      {/* 主图像层（AI.gif 动态图） */}
      <div className="avatar-image-wrapper">
        <img src={finalSrc} alt="avatar" className="avatar-image" draggable={false} />
      </div>

      {/* 呼吸光晕 */}
      <div className="avatar-glow" />

      {/* 状态指示器 */}
      {state === "thinking" && (
        <div className="avatar-thinking-dots">
          <span className="dot dot-1" />
          <span className="dot dot-2" />
          <span className="dot dot-3" />
        </div>
      )}

      {state === "speaking" && (
        <div className="avatar-speaking-waves">
          <span className="wave wave-1" />
          <span className="wave wave-2" />
          <span className="wave wave-3" />
        </div>
      )}

      {state === "error" && (
        <div className="avatar-error-indicator">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="5" fill="var(--destructive)"/>
            <path d="M6 3.5v3M6 8h.01" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
      )}
    </div>
  )
}
