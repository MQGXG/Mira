"use client";

import { type ReactNode } from "react";

/**
 * 消息气泡 — 封装用户/助手消息气泡的样式与溢出处理。
 * 参考 OpenCode session-ui 的 Message 组件，将气泡样式集中管理：
 * - 统一 overflow-wrap / word-break，防止长文本溢出
 * - 统一错误状态展示
 * - 通过 role 区分左右对齐与配色
 */
interface MessageBubbleProps {
  role: "user" | "assistant";
  children: ReactNode;
  className?: string;
}

export function MessageBubble({ role, children, className = "" }: MessageBubbleProps) {
  return (
    <div className={`bubble-${role} ${className}`}>
      {children}
    </div>
  );
}

/** 消息错误提示条 — 模型失败等场景的友好错误展示 */
export function MessageError({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div
      className="mt-2 rounded-md px-3 py-2 text-xs max-w-full"
      style={{
        background: "rgba(239,68,68,0.08)",
        color: "var(--error)",
        overflowWrap: "break-word",
        wordBreak: "break-word",
      }}
    >
      {text}
    </div>
  );
}
