import type { MiraPart, MiraMessage } from "./types-message";
import {
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
} from "../components/assistant-ui/tool-fallback";
import { ToolReadView } from "./tool-views/ToolReadView";
import { ToolShellView } from "./tool-views/ToolShellView";
import { ToolSearchView } from "./tool-views/ToolSearchView";
import { ToolDiffView } from "./tool-views/ToolDiffView";
import { ToolGenericView } from "./tool-views/ToolGenericView";
import { ContextToolGroup } from "./tool-views/ContextToolGroup";
import { ToolDiffSummary } from "./tool-views/ToolDiffSummary";
import { getFoldConfig } from "./tool-views/tool-fold";
import { getToolIcon, getToolColor } from "./tool-views/ToolIcon";
import { RotateCcw } from "lucide-react";

/** 回退按钮 — 恢复到工具执行前的文件状态 */
function RevertButton({ snapshotId, toolName }: { snapshotId?: string; toolName: string }) {
  if (!snapshotId) return null;
  const handleRevert = async () => {
    try {
      const workspace = window.electronAPI.platform === "win32" ? "C:\\" : "/";
      const restored = await window.electronAPI.ts.restoreSnapshot(snapshotId, workspace);
      alert(`已恢复 ${restored.length} 个文件`);
    } catch (e: any) {
      alert(`恢复失败: ${e.message || e}`);
    }
  };
  return (
    <button onClick={(e) => { e.stopPropagation(); handleRevert(); }}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-muted transition-colors"
      style={{ color: "var(--fg-tertiary)" }} title="回退到执行前">
      <RotateCcw className="w-2.5 h-2.5" />
      回退
    </button>
  );
}

/** 上下文工具 — 会被自动分组 */
const CONTEXT_TOOLS = new Set(["read_file", "list_files", "glob", "grep", "code_search", "search_history"]);

interface ToolCallPartProps {
  part: MiraPart;
}

/** 上下文工具分组检测 */
export function groupParts(parts: MiraPart[]): (MiraPart | MiraPart[])[] {
  const result: (MiraPart | MiraPart[])[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (
      part.type === "tool-call" &&
      part.toolName &&
      CONTEXT_TOOLS.has(part.toolName)
    ) {
      const group: MiraPart[] = [];
      while (i < parts.length) {
        const p = parts[i];
        if (p.type === "tool-call" && p.toolName && CONTEXT_TOOLS.has(p.toolName)) {
          group.push(p);
          i++;
        } else {
          break;
        }
      }
      result.push(group);
    } else {
      result.push(parts[i]);
      i++;
    }
  }
  return result;
}

/** 检查一组 ContextTool 是否全部完成 */
function allDone(group: MiraPart[]): boolean {
  return group.every((p) => p.type === "tool-call" && p.status === "done");
}

/** 检测消息中是否有 diff-summary */
export function findDiffSummary(message: MiraMessage): MiraPart | undefined {
  return message.parts.find(p => p.type === "diff-summary");
}

/** 渲染消息的所有 Parts（用在 ChatWindow 中） */
export function RenderMessageParts({ message }: { message: MiraMessage }) {
  const groups = groupParts(message.parts);

  return (
    <>
      {groups.map((item, i) => {
        if (Array.isArray(item)) {
          return <ContextToolGroup key={`ctx-${i}`} parts={item} allDone={allDone(item)} />;
        }
        switch (item.type) {
          case "thinking":
          case "reasoning":
            return null; // handled separately by ChatWindow
          case "text":
            return null; // handled by assistant-ui MessagePrimitive.Parts
          case "tool-call":
            return <SingleToolCallView key={item.toolCallId || i} part={item} />;
          case "diff-summary":
            return <ToolDiffSummary key={`diff-${i}`} files={item.files!} />;
          case "compaction":
            return (
              <div key={`cmp-${i}`} className="flex items-center gap-3 py-1.5">
                <div className="flex-1 h-px" style={{ background: "var(--border-subtle)" }} />
                <span className="text-[10px] font-medium whitespace-nowrap" style={{ color: "var(--fg-tertiary)" }}>
                  {item.text || "Context compressed"}
                </span>
                <div className="flex-1 h-px" style={{ background: "var(--border-subtle)" }} />
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/** 单个工具调用渲染 */
function SingleToolCallView({ part }: ToolCallPartProps) {
  if (part.type !== "tool-call") return null;

  const ViewComponent = toolViewRoute[part.toolName || ""];
  if (ViewComponent) {
    return <ViewComponent part={part} />;
  }

  if (part.status === "done" && part.result) {
    return <ToolGenericView info={{
      toolCallId: part.toolCallId || "",
      name: part.toolName || "",
      args: part.args || {},
      result: part.result,
      status: part.status === "done" ? "done" : "error",
    }} />;
  }

  return <ToolFallbackRender part={part} />;
}

/** 文件类工具 */
function ReadFileTool({ part }: ToolCallPartProps) {
  return <ToolReadView result={part.result || ""} args={part.args || {}} />;
}

/** Shell 类工具 */
function BashTool({ part }: ToolCallPartProps) {
  return <ToolShellView result={part.result || ""} args={part.args || {}} />;
}

function CodeExecTool({ part }: ToolCallPartProps) {
  return <ToolShellView result={part.result || ""} args={part.args || {}} />;
}

/** 搜索类工具 */
function WebSearchTool({ part }: ToolCallPartProps) {
  return <ToolSearchView result={part.result || ""} args={part.args || {}} />;
}

function WebBrowseTool({ part }: ToolCallPartProps) {
  return <ToolSearchView result={part.result || ""} args={part.args || {}} />;
}

/** Diff 类工具（带回退按钮） */
function WriteFileTool({ part }: ToolCallPartProps) {
  if (part.status === "running") return <ToolFallbackRender part={part} />;
  return (
    <div>
      <div className="flex items-center gap-1 px-1 pt-1">
        <RevertButton snapshotId={part.snapshotId} toolName={part.toolName || ""} />
      </div>
      <ToolDiffView result={part.result || ""} args={part.args || {}} name={part.toolName || ""} />
    </div>
  );
}

function EditFileTool({ part }: ToolCallPartProps) {
  if (part.status === "running") return <ToolFallbackRender part={part} />;
  return (
    <div>
      <div className="flex items-center gap-1 px-1 pt-1">
        <RevertButton snapshotId={part.snapshotId} toolName={part.toolName || ""} />
      </div>
      <ToolDiffView result={part.result || ""} args={part.args || {}} name={part.toolName || ""} />
    </div>
  );
}

function ApplyPatchTool({ part }: ToolCallPartProps) {
  if (part.status === "running") return <ToolFallbackRender part={part} />;
  return (
    <div>
      <div className="flex items-center gap-1 px-1 pt-1">
        <RevertButton snapshotId={part.snapshotId} toolName={part.toolName || ""} />
      </div>
      <ToolDiffView result={part.result || ""} args={part.args || {}} name={part.toolName || ""} />
    </div>
  );
}

/** 通用回退（旧 ToolFallback 风格） */
function ToolFallbackRender({ part }: ToolCallPartProps) {
  const config = getFoldConfig(part.toolName || "");
  const isRun = part.status === "running";
  return (
    <ToolFallbackRoot defaultOpen={!isRun || config.defaultExpanded}>
      <ToolFallbackTrigger toolName={part.toolName || ""} status={isRun ? { type: "running" } : part.status === "done" ? { type: "complete" } : { type: "incomplete", reason: "error" as const }} />
      <ToolFallbackContent>
        <ToolFallbackArgs argsText={JSON.stringify(part.args || {}, null, 2)} />
        {part.result && <ToolFallbackResult result={part.result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
}

const toolViewRoute: Record<string, React.ComponentType<ToolCallPartProps>> = {
  read_file: ReadFileTool,
  list_files: ReadFileTool,
  bash: BashTool,
  code_exec: CodeExecTool,
  web_search: WebSearchTool,
  web_browse: WebBrowseTool,
  write_file: WriteFileTool,
  edit_file: EditFileTool,
  apply_patch: ApplyPatchTool,
};

export function ToolCallView({ part }: ToolCallPartProps) {
  return <SingleToolCallView part={part} />;
}
