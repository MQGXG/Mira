import { useState, useEffect } from "react";
import { Terminal, ChevronDown, ChevronRight } from "lucide-react";
import { getFoldConfig, expandToolOutput } from "./tool-fold";

interface Props {
  result: string;
  args: Record<string, unknown>;
}

export function ToolShellView({ result, args }: Props) {
  const command = (args.command as string) || "";
  const config = getFoldConfig("bash");
  const [expanded, setExpanded] = useState(config.defaultExpanded);
  const { preview, hasMore, totalLines } = expandToolOutput(result, "bash");

  return (
    <div className="rounded-xl border border-standard overflow-hidden animate-fade-in-up" style={{ background: "var(--card)" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
        style={{ color: "var(--fg-secondary)" }}
      >
        <Terminal className="w-3.5 h-3.5 text-warning" />
        <code className="truncate font-mono" style={{ color: "var(--warning)" }}>{command || "shell"}</code>
        <span className="text-[10px] ml-auto" style={{ color: "var(--fg-tertiary)" }}>{totalLines} lines</span>
        {expanded ? <ChevronDown className="w-3 h-3 ml-1" /> : <ChevronRight className="w-3 h-3 ml-1" />}
      </button>

      {expanded && (
        <div className="border-t border-standard">
          <pre className="px-3 py-2 text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto leading-relaxed whitespace-pre-wrap" style={{ color: "var(--fg)" }}>
            {result}
          </pre>
        </div>
      )}

      {!expanded && (
        <div className="border-t border-standard">
          <pre className="px-3 py-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap line-clamp-3" style={{ color: "var(--fg-secondary)" }}>
            {preview}
          </pre>
          {hasMore && (
            <div className="px-3 pb-2 text-[10px]" style={{ color: "var(--fg-tertiary)" }}>
              ... {totalLines} lines total
            </div>
          )}
        </div>
      )}
    </div>
  );
}
