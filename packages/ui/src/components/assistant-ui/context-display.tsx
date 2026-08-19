"use client";

import { useAuiState } from "@assistant-ui/react";
import { cn } from "../../lib/utils";

interface Props {
  className?: string;
  maxTokens?: number;
}

export function ContextDisplay({ className, maxTokens = 128000 }: Props) {
  const messages = useAuiState((s) => s.thread.messages);
  const estimated = messages?.length ? Math.min(Math.round(messages.length * 500), maxTokens) : 0;
  const pct = Math.min((estimated / maxTokens) * 100, 100);

  if (estimated === 0) return null;

  return (
    <div
      className={cn("flex items-center gap-1.5 text-[10px]", className)}
      style={{ color: "var(--text-tertiary)" }}
      title={`约 ${estimated.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
        <circle cx="6" cy="6" r="5" fill="none" stroke="var(--border)" strokeWidth="1.5" />
        <circle
          cx="6" cy="6" r="5" fill="none"
          stroke={pct > 80 ? "var(--error)" : "var(--primary)"}
          strokeWidth="1.5"
          strokeDasharray={`${pct * 0.314} 31.4`}
          transform="rotate(-90 6 6)"
          strokeLinecap="round"
        />
      </svg>
      <span>{Math.round(pct)}%</span>
    </div>
  );
}
