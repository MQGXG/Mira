/**
 * Cmd+K 命令面板 — 键盘优先的万能搜索（项目 / 会话 / 动作）
 * 触发：Ctrl+K / Cmd+K（由 App.tsx 全局快捷键控制显隐）
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, Settings, Network, MessageSquare, FolderOpen } from "lucide-react";
import { SessionService, type SearchResult } from "../services/session.service";

interface Project {
  project_id: string;
  name: string;
  workspace_path: string;
  color: string;
}

interface ActionItem {
  id: string;
  label: string;
  keywords: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

interface Props {
  projects: Project[];
  activeProject: string;
  onSelectProject: (projectId: string) => void;
  onOpenSession: (sessionId: string) => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  onOpenGraph: () => void;
  onClose: () => void;
}

interface GroupItem {
  key: string;
  label: string;
  kind: "project" | "session" | "action";
  title: string;
  subtitle?: string;
  color?: string;
  icon?: React.ReactNode;
  onSelect: () => void;
}

/** 简单模糊匹配：包含 + 首字母缩写（不引入新依赖） */
function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (t.includes(q)) return true;
  // 首字母匹配（如 "qdg" → "前端重构"）
  if (q.length >= 2) {
    const initials = t
      .split(/[\s\-_]+/)
      .map((s) => s[0])
      .join("");
    if (initials.includes(q)) return true;
  }
  return false;
}

export function CommandPalette({
  projects, activeProject, onSelectProject, onOpenSession,
  onNewSession, onOpenSettings, onOpenGraph, onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [sessionResults, setSessionResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // 会话搜索（防抖 150ms）
  useEffect(() => {
    if (!query.trim()) { setSessionResults([]); return; }
    const timer = setTimeout(async () => {
      try { setSessionResults(await SessionService.search(query)); } catch { setSessionResults([]); }
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const actions: ActionItem[] = useMemo(() => [
    { id: "new-session", label: "新建会话", keywords: "新建 会话 new", icon: <Plus className="w-4 h-4" />, onSelect: onNewSession },
    { id: "open-settings", label: "打开设置", keywords: "设置 配置 settings 快捷键", icon: <Settings className="w-4 h-4" />, onSelect: onOpenSettings },
    { id: "open-graph", label: "打开知识图谱", keywords: "图谱 知识 memory graph", icon: <Network className="w-4 h-4" />, onSelect: onOpenGraph },
  ], [onNewSession, onOpenSettings, onOpenGraph]);

  // 聚合搜索结果（项目 + 会话 + 动作）
  const items = useMemo<GroupItem[]>(() => {
    const list: GroupItem[] = [];
    const matchedProjects = projects
      .filter((p) => fuzzyMatch(`${p.name} ${p.workspace_path}`, query))
      .map((p) => ({
        key: `proj-${p.project_id}`,
        label: "项目",
        kind: "project" as const,
        title: p.name,
        subtitle: p.workspace_path,
        color: p.color,
        onSelect: () => onSelectProject(p.project_id),
      }));
    list.push(...matchedProjects);

    const matchedSessions = sessionResults
      .filter((r) => fuzzyMatch(`${r.session_title} ${r.message?.content || ""}`, query))
      .slice(0, 8)
      .map((r) => ({
        key: `sess-${r.session_id}`,
        label: "会话",
        kind: "session" as const,
        title: r.session_title,
        subtitle: r.message?.content || "",
        onSelect: () => onOpenSession(String(r.session_id)),
      }));
    list.push(...matchedSessions);

    const matchedActions = actions
      .filter((a) => fuzzyMatch(`${a.label} ${a.keywords}`, query))
      .map((a) => ({
        key: `act-${a.id}`,
        label: "动作",
        kind: "action" as const,
        title: a.label,
        icon: a.icon,
        onSelect: a.onSelect,
      }));
    list.push(...matchedActions);

    return list;
  }, [projects, sessionResults, actions, query, onSelectProject, onOpenSession]);

  // 分组展示
  const grouped = useMemo(() => {
    const g: { label: string; items: GroupItem[] }[] = [];
    for (const item of items) {
      const group = g.find((x) => x.label === item.label);
      if (group) group.items.push(item);
      else g.push({ label: item.label, items: [item] });
    }
    return g;
  }, [items]);

  useEffect(() => { setSelectedIndex(0); }, [query, sessionResults]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && items[selectedIndex]) { items[selectedIndex].onSelect(); }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }} />
      <div
        className="relative mt-[12vh] w-full max-w-lg mx-4 rounded-2xl shadow-glass-lg overflow-hidden animate-scale-in"
        style={{ background: "var(--surface-elevated)", border: "1px solid var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 搜索框 */}
        <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <Search className="w-4 h-4 shrink-0" style={{ color: "var(--fg-tertiary)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索项目、会话、动作..."
            className="flex-1 bg-transparent outline-none text-sm min-w-0"
            style={{ color: "var(--fg)" }}
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: "var(--bg)", border: "1px solid var(--border)", color: "var(--fg-tertiary)" }}>Esc</kbd>
        </div>

        {/* 结果列表 */}
        <div className="max-h-[60vh] overflow-y-auto scrollbar-custom py-1.5">
          {items.length === 0 && (
            <div className="px-4 py-8 text-center text-xs" style={{ color: "var(--fg-tertiary)" }}>
              {query ? "未找到匹配结果" : "输入关键字开始搜索"}
            </div>
          )}
          {grouped.map((group) => (
            <div key={group.label}>
              <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--fg-tertiary)" }}>
                {group.label}
              </div>
              {group.items.map((item) => {
                const globalIdx = items.indexOf(item);
                const isActive = globalIdx === selectedIndex;
                return (
                  <button
                    key={item.key}
                    onClick={item.onSelect}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors"
                    style={{
                      background: isActive ? "color-mix(in srgb, var(--primary) 10%, transparent)" : "transparent",
                    }}
                  >
                    <span
                      className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-[10px] font-bold text-white"
                      style={{ background: item.kind === "project" ? (item.color || "var(--bg-tertiary)") : "var(--bg-tertiary)", color: item.kind === "project" ? "#fff" : "var(--fg-secondary)" }}
                    >
                      {item.kind === "project" ? item.title[0]?.toUpperCase() : item.kind === "action" ? <>{item.icon}</> : <MessageSquare className="w-3.5 h-3.5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ color: "var(--fg)" }}>{item.title}</div>
                      {item.subtitle && (
                        <div className="text-[11px] truncate mt-0.5 flex items-center gap-1" style={{ color: "var(--fg-tertiary)" }}>
                          {item.kind === "session" && <MessageSquare className="w-2.5 h-2.5 shrink-0" />}
                          {item.kind === "project" && <FolderOpen className="w-2.5 h-2.5 shrink-0" />}
                          <span className="truncate">{item.subtitle}</span>
                        </div>
                      )}
                    </div>
                    {item.kind === "project" && item.key.includes(activeProject) && (
                      <span className="text-[10px] shrink-0" style={{ color: "var(--primary)" }}>当前</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* 底部提示 */}
        <div className="flex items-center gap-3 px-4 py-2 text-[10px]" style={{ borderTop: "1px solid var(--border-subtle)", color: "var(--fg-tertiary)" }}>
          <span><kbd className="px-1 py-0.5 rounded" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>↑↓</kbd> 导航</span>
          <span><kbd className="px-1 py-0.5 rounded" style={{ background: "var(--bg)", border: "1px solid var(--border)" }}>↵</kbd> 选择</span>
          <span className="ml-auto">Ctrl+K 切换</span>
        </div>
      </div>
    </div>
  );
}
