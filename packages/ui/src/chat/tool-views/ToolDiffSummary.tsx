import { useState, useRef, useEffect } from "react";
import { FileEdit, ChevronDown, ChevronRight } from "lucide-react";
import type { DiffFileEntry } from "../types-message";
import { DiffViewer } from "../../components/assistant-ui/diff-viewer";
import { cn } from "../../lib/utils";

interface Props {
  files: DiffFileEntry[];
}

export function ToolDiffSummary({ files }: Props) {
  const [expanded, setExpanded] = useState(false);
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  if (files.length === 0) return null;

  return (
    <div className="rounded-xl border border-standard overflow-hidden animate-fade-in-up mt-3" style={{ background: "var(--card)" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
        style={{ color: "var(--fg-secondary)" }}
      >
        <FileEdit className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--primary)" }} />
        <span className="font-medium" style={{ color: "var(--fg)" }}>
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </span>
        <span className="text-[10px] font-mono">
          <span style={{ color: "var(--success)" }}>+{totalAdditions}</span>
          {" "}
          <span style={{ color: "var(--error)" }}>-{totalDeletions}</span>
        </span>
        {expanded ? <ChevronDown className="w-3 h-3 ml-auto shrink-0" /> : <ChevronRight className="w-3 h-3 ml-auto shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-standard divide-y divide-border-standard">
          {files.map((file, i) => (
            <FileDiffItem key={file.filePath} file={file} defaultOpen={i === 0 && files.length === 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileDiffItem({ file, defaultOpen }: { file: DiffFileEntry; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
        style={{ color: "var(--fg-secondary)" }}
      >
        <span className="font-mono truncate" style={{ color: "var(--fg)" }}>{file.filePath}</span>
        <span className="text-[10px] font-mono ml-auto shrink-0">
          <span style={{ color: "var(--success)" }}>+{file.additions}</span>
          {" "}
          <span style={{ color: "var(--error)" }}>-{file.deletions}</span>
        </span>
        {open ? <ChevronDown className="w-3 h-3 ml-1 shrink-0" /> : <ChevronRight className="w-3 h-3 ml-1 shrink-0" />}
      </button>
      {open && (
        <div ref={contentRef} className="border-t border-standard">
          <DiffViewer
            oldFile={{ content: file.oldContent, name: file.filePath }}
            newFile={{ content: file.newContent, name: file.filePath }}
            showStats={false}
            showIcon={false}
            viewMode="unified"
          />
        </div>
      )}
    </div>
  );
}
