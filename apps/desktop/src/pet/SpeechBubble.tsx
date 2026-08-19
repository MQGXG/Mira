import { useEffect, useState } from "react"

interface SpeechBubbleProps {
  role: "user" | "assistant"
  content: string
}

export function SpeechBubble({ role, content }: SpeechBubbleProps) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10)
    return () => clearTimeout(t)
  }, [])

  const isUser = role === "user"

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 0.25s ease, transform 0.25s ease",
      }}
    >
      <div
        style={{
          position: "relative",
          maxWidth: "85%",
          padding: "6px 11px",
          borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
          background: isUser
            ? "var(--bubble-user-bg)"
            : "rgba(255,255,255,0.08)",
          border: isUser ? "none" : "1px solid rgba(255,255,255,0.12)",
          fontSize: 13,
          lineHeight: 1.5,
          color: isUser ? "var(--bubble-user-fg)" : "rgba(255,255,255,0.9)",
          fontFamily: "inherit",
          wordBreak: "break-word",
          boxShadow: isUser
            ? "0 1px 4px rgba(0,0,0,0.25)"
            : "0 1px 4px rgba(0,0,0,0.2)",
        }}
      >
        {content || (isUser ? "" : <span style={{ opacity: 0.5 }}>...</span>)}
      </div>
    </div>
  )
}
