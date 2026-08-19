import { useState, useMemo, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, FileSearch, Loader2, CheckCircle2 } from "lucide-react";
import type { MiraPart } from "../types-message";
import { getToolIcon } from "./ToolIcon";
import { cn } from "../../lib/utils";

interface Props {
  parts: MiraPart[];
  allDone: boolean;
}

/** 上下文工具组 — 连续的 read/glob/grep/list 自动聚合为一个折叠面板 */
export function ContextToolGroup({ parts, allDone }: Props) {
  const [expanded, setExpanded] = useState(false);
  const prevDone = useRef(false);
  const [title, setTitle] = useState("Gathering context...");

  useEffect(() => {
    if (allDone && !prevDone.current) {
      prevDone.current = true;
      setTitle("Gathered context");
    }
  }, [allDone]);

  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of parts) {
      if (p.type === "tool-call" && p.toolName) {
        const name = p.toolName.replace(/_/g, " ");
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    return Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(", ");
  }, [parts]);

  return (
    <div className="rounded-xl border border-standard overflow-hidden animate-fade-in-up" style={{ background: "var(--card)" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
        style={{ color: "var(--fg-secondary)" }}
      >
        <FileSearch className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--primary)" }} />
        <span className="font-medium" style={{ color: "var(--fg)" }}>{title}</span>
        {!allDone && <Loader2 className="w-3 h-3 animate-spin shrink-0" style={{ color: "var(--primary)" }} />}
        {allDone && <CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: "var(--success)" }} />}
        <span className="text-[10px] truncate ml-1" style={{ color: "var(--fg-tertiary)" }}>{summary}</span>
        {expanded ? <ChevronDown className="w-3 h-3 ml-auto shrink-0" /> : <ChevronRight className="w-3 h-3 ml-auto shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-standard divide-y divide-border-standard">
          {parts.map((part, i) => {
            if (part.type !== "tool-call") return null;
            const Icon = getToolIcon(part.toolName || "");
            const subtitle = getSubtitle(part);
            return (
              <div key={part.toolCallId || i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <Icon className="w-3 h-3 shrink-0" style={{ color: "var(--fg-tertiary)" }} />
                <span className="font-mono font-medium" style={{ color: "var(--primary)" }}>
                  {part.toolName}
                </span>
                {subtitle && (
                  <span className="truncate" style={{ color: "var(--fg-tertiary)" }}>{subtitle}</span>
                )}
                {part.status === "running" && <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0 ml-auto" />}
                {part.status === "done" && <CheckCircle2 className="w-2.5 h-2.5 shrink-0 ml-auto" style={{ color: "var(--success)" }} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getSubtitle(part: MiraPart): string {
  if (!part.args) return "";
  const { path, pattern, query, dir } = part.args as { path?: string; pattern?: string; query?: string; dir?: string };
  return path || pattern || query || dir || "";
}
