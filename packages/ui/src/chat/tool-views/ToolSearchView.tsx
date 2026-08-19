import { useState } from "react";
import { Globe, ExternalLink, ChevronDown, ChevronRight } from "lucide-react";
import { getFoldConfig } from "./tool-fold";

interface Props {
  result: string;
  args: Record<string, unknown>;
}

export function ToolSearchView({ result, args }: Props) {
  const query = (args.query as string) || "";
  const config = getFoldConfig("web_search");
  const [expanded, setExpanded] = useState(config.defaultExpanded);

  // 解析搜索结果为结构化条目
  const entries = result.split("\n\n").filter(Boolean).map((block) => {
    const linkMatch = block.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      return {
        title: linkMatch[1],
        url: linkMatch[2],
        snippet: block.replace(/^\[([^\]]+)\]\(([^)]+)\)\n?/, "").replace(/^>\s?/, ""),
      };
    }
    return { title: block, url: "", snippet: "" };
  });

  return (
    <div className="rounded-xl border border-standard overflow-hidden animate-fade-in-up" style={{ background: "var(--card)" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
        style={{ color: "var(--fg-secondary)" }}
      >
        <Globe className="w-3.5 h-3.5 text-info" />
        <span className="truncate" style={{ color: "var(--info)" }}>{query || "搜索结果"}</span>
        <span className="ml-1" style={{ color: "var(--fg-tertiary)" }}>({entries.length} 条结果)</span>
        {expanded ? <ChevronDown className="w-3 h-3 ml-auto" /> : <ChevronRight className="w-3 h-3 ml-auto" />}
      </button>

      {expanded && (
        <div className="border-t border-standard divide-y divide-border-standard">
          {entries.map((entry, i) => (
            <div key={i} className="px-3 py-2.5 space-y-1">
              {entry.url ? (
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-sm font-medium transition-colors hover:opacity-80"
                  style={{ color: "var(--primary)" }}
                >
                  {entry.title}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              ) : (
                <div className="text-sm font-medium" style={{ color: "var(--fg)" }}>{entry.title}</div>
              )}
              {entry.snippet && (
                <p className="text-xs leading-relaxed line-clamp-3" style={{ color: "var(--fg-tertiary)" }}>{entry.snippet}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
