import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle } from "lucide-react";
import type { ToolCallInfo } from "../types";

interface Props {
  info: ToolCallInfo;
}

export function ToolGenericView({ info }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ml-8 mt-2 rounded-xl border border-standard overflow-hidden animate-fade-in-up" style={{ background: "var(--card)" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
        style={{ color: "var(--fg-secondary)" }}
      >
        {info.status === "running" ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-warning" />
        ) : info.status === "done" ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success" />
        ) : (
          <XCircle className="w-3.5 h-3.5 text-error" />
        )}
        <span className="font-mono">{info.name}</span>
        {expanded ? <ChevronDown className="w-3 h-3 ml-auto" /> : <ChevronRight className="w-3 h-3 ml-auto" />}
      </button>

      {expanded && info.result && (
        <div className="border-t border-standard">
          <pre className="px-3 py-2 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap" style={{ color: "var(--fg-secondary)" }}>
            {info.result}
          </pre>
        </div>
      )}
    </div>
  );
}
