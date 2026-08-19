import { useState, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { MessageSquarePlus, Trash2, MessageSquare, Search, X, FileText, Check, Pencil, ListChecks } from "lucide-react";
import { SessionService, type SessionInfo } from "../services/session.service";
import { type ProjectInfo } from "../services/project.service";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { subscribe as subscribeRuntime, getVersion as getRuntimeVersion, isSessionRunning, disposeSession } from "../hooks/session-runtime-store";
import { ProjectBar } from "./ProjectBar";

interface Props {
  open: boolean;
  onClose: () => void;
  activeProject: string;
  activeSession: string;
  projects: ProjectInfo[];
  onProjectChange: (projectId: string) => void;
  onSessionChange: (sessionId: string) => void;
  onNewSession: () => void;
  onOpenProject: () => void;
  onEditProject: (project: ProjectInfo) => void;
  onDeleteProject: (projectId: string) => void;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)}天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatCost(cost?: number): string {
  if (!cost || cost <= 0) return "";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function getTimeGroup(iso: string): string {
  if (!iso) return "其他";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "其他";
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (diff < dayMs) return "今天";
  if (diff < 2 * dayMs) return "昨天";
  if (diff < 7 * dayMs) return "7天内";
  return "30天内";
}

/** 排序：刚更新（1分钟内）的会话置顶，其余按时间降序 */
function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  const ONE_MINUTE = 60 * 1000;
  const now = Date.now();
  return [...sessions].sort((a, b) => {
    const aTime = new Date(a.updated_at || 0).getTime();
    const bTime = new Date(b.updated_at || 0).getTime();
    const aRecent = now - aTime < ONE_MINUTE;
    const bRecent = now - bTime < ONE_MINUTE;
    if (aRecent && !bRecent) return -1;
    if (!aRecent && bRecent) return 1;
    return bTime - aTime;
  });
}

function SessionTitle({ session, onRename, onSessionChange }: {
  session: SessionInfo;
  onRename: (id: string, title: string) => void;
  onSessionChange: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(session.title || "新会话");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setValue(session.title || "新会话");
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function save() {
    const trimmed = value.trim();
    if (trimmed && trimmed !== (session.title || "新会话")) {
      onRename(session.session_id, trimmed);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
          onBlur={save}
          className="flex-1 text-xs font-medium bg-transparent outline-none border-b border-current min-w-0"
          style={{ color: "var(--fg)" }}
        />
        <button onMouseDown={(e) => { e.preventDefault(); save(); }} className="p-0.5 shrink-0">
          <Check className="w-3 h-3" style={{ color: "var(--success)" }} />
        </button>
      </div>
    );
  }

  return (
    <div
      className="text-xs font-medium truncate cursor-text"
      style={{ color: "var(--fg)" }}
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
    >
      {session.title || "新会话"}
    </div>
  );
}

function SidebarContent({ activeProject, activeSession, projects, onProjectChange, onSessionChange, onNewSession, onOpenProject, onEditProject, onDeleteProject }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[] | null>(null);

  // 订阅会话运行时 store，用于显示"运行中"徽标
  useSyncExternalStore(subscribeRuntime, getRuntimeVersion);

  const project = useMemo(() => projects.find((p) => p.project_id === activeProject), [projects, activeProject]);

  const loadSessions = async () => {
    if (!activeProject) { setSessions([]); return; }
    try {
      const list = await SessionService.list(activeProject);
      setSessions(list);
    } catch { /* ignore */ }
  };

  useEffect(() => { loadSessions(); const timer = setInterval(loadSessions, 10000); return () => clearInterval(timer); }, [activeProject]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        onNewSession();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onNewSession]);

  /** 内联重命名会话 */
  const handleRename = async (sessionId: string, title: string) => {
    try {
      await SessionService.update(sessionId, { title });
      loadSessions();
    } catch { /* ignore */ }
  };

  /** 按时间分组 + 排序优化 */
  const groupedSessions = useMemo(() => {
    const groups: Record<string, SessionInfo[]> = { "今天": [], "昨天": [], "7天内": [], "30天内": [], "其他": [] };
    sessions.forEach((s) => { const g = getTimeGroup(s.updated_at); if (groups[g]) groups[g].push(s); });
    // 每个组内排序：刚更新的置顶，其余按时间降序
    for (const key of Object.keys(groups)) {
      groups[key] = sortSessions(groups[key]);
    }
    return groups;
  }, [sessions]);

  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({ "今天": true, "昨天": true, "7天内": true, "30天内": true });

  // ── 批量管理模式：多选会话后一次性删除 ────────────────
  const [manageMode, setManageMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const enterManage = () => { setSearchQuery(""); setSearchResults(null); setManageMode(true); };
  const exitManage = () => { setManageMode(false); setSelectedIds(new Set()); };

  const toggleSelect = (sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
      return next;
    });
  };

  /** 全选/全不选切换（作用于当前项目全部会话） */
  const handleSelectAll = () => {
    if (selectedIds.size === sessions.length) { setSelectedIds(new Set()); return; }
    setSelectedIds(new Set(sessions.map((s) => s.session_id)));
  };

  /** 批量删除选中会话 */
  const handleDeleteSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 个会话吗？此操作不可恢复。`)) return;
    try {
      ids.forEach((id) => disposeSession(id));
      await SessionService.deleteMany(ids);
      if (activeSession && ids.includes(activeSession)) onNewSession();
    } catch { /* ignore */ } finally {
      exitManage();
      loadSessions();
    }
  };

  // L6 侧边栏项目搜索：本地过滤项目名/路径（零延迟），与会话搜索结果并列展示
  const matchedProjects = useMemo(() => {
    if (!searchQuery.trim()) return null;
    const q = searchQuery.trim().toLowerCase();
    return projects.filter((p) =>
      p.name.toLowerCase().includes(q) || (p.workspace_path || "").toLowerCase().includes(q),
    );
  }, [searchQuery, projects]);

  return (
    <div className="flex h-full">
      {/* L1 竖排项目图标栏（拖拽排序 + 分组 + 最近访问排序） */}
      <ProjectBar
        projects={projects}
        activeProject={activeProject}
        onProjectChange={onProjectChange}
        onOpenProject={onOpenProject}
        onEditProject={onEditProject}
        onDeleteProject={onDeleteProject}
      />

      {/* 右侧内容 */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* 当前项目信息 */}
        <div className="p-3 pb-2 flex items-center gap-2.5 shrink-0" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold truncate" style={{ color: "var(--fg)" }}>{project?.name || "未选择项目"}</span>
              {project && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: project.color }} />}
            </div>
            {project?.workspace_path && <div className="text-[11px] truncate mt-0.5" style={{ color: "var(--fg-tertiary)" }}>{project.workspace_path}</div>}
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2 pt-3 relative">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--fg-tertiary)" }} />
            <Input value={searchQuery} onChange={async (e) => {
              const v = e.target.value; setSearchQuery(v);
              if (!v.trim()) { setSearchResults(null); return; }
              try { setSearchResults(await SessionService.search(v)); } catch { setSearchResults([]); }
            }} placeholder="搜索项目/会话..." className="pl-9 pr-3 py-2 text-xs" />
            {searchQuery && <Button variant="ghost" size="icon" className="h-6 w-6 absolute right-2 top-1/2 -translate-y-1/2" onClick={() => { setSearchQuery(""); setSearchResults(null); }}><X className="h-3 w-3" /></Button>}
          </div>
        </div>

        {/* Search results */}
        {searchResults !== null && (
          <div className="mx-3 rounded-lg overflow-hidden" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", boxShadow: "var(--shadow-floating)", zIndex: 10 }}>
            <div className="px-3 py-2 text-xs font-medium" style={{ color: "var(--fg-tertiary)", borderBottom: "1px solid var(--border-subtle)" }}>
              {matchedProjects && matchedProjects.length > 0
                ? `找到 ${matchedProjects.length} 个项目 · ${searchResults.length} 条会话`
                : `找到 ${searchResults.length} 条结果`}
            </div>
            <div className="max-h-48 overflow-y-auto scrollbar-custom">
              {/* 项目匹配 */}
              {matchedProjects && matchedProjects.length > 0 && (
                <>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--fg-tertiary)" }}>项目</div>
                  {matchedProjects.map((p) => (
                    <button key={p.project_id} onClick={() => { onProjectChange(p.project_id); setSearchResults(null); setSearchQuery(""); }}
                      className="w-full text-left px-3 py-2 transition-colors hover:bg-black/3 dark:hover:bg-white/3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
                      <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} /><span className="font-medium truncate" style={{ color: "var(--fg)" }}>{p.name}</span></div>
                      <p className="text-[11px] truncate mt-0.5 ml-4" style={{ color: "var(--fg-tertiary)" }}>{p.workspace_path}</p>
                    </button>
                  ))}
                </>
              )}
              {/* 会话匹配 */}
              {searchResults.length === 0 && !(matchedProjects && matchedProjects.length > 0) ? (
                <p className="text-xs py-6 text-center" style={{ color: "var(--fg-tertiary)" }}>未找到匹配内容</p>
              ) : (
                searchResults.map((r, i) => (
                  <button key={i} onClick={() => { onSessionChange(String(r.session_id)); setSearchResults(null); setSearchQuery(""); }}
                    className="w-full text-left px-3 py-2.5 transition-colors hover:bg-black/3 dark:hover:bg-white/3" style={{ borderBottom: i < searchResults.length - 1 ? "1px solid var(--border-subtle)" : "none" }}>
                    <div className="flex items-center gap-2 text-xs"><MessageSquare className="w-3 h-3 shrink-0" style={{ color: "var(--fg-tertiary)" }} /><span className="font-medium truncate" style={{ color: "var(--fg)" }}>{r.session_title}</span></div>
                    <p className="text-[11px] line-clamp-2 mt-1 ml-5" style={{ color: "var(--fg-tertiary)" }}>{r.message.content}</p>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* 会话列表工具条（批量管理入口） */}
        {project && (
          <div className="px-3 pb-1.5 pt-0.5 flex items-center gap-2 shrink-0">
            {manageMode ? (
              <>
                <Button variant="ghost" size="sm" className="text-[11px] px-2" onClick={handleSelectAll}>
                  {selectedIds.size === sessions.length && sessions.length > 0 ? "取消全选" : "全选"}
                </Button>
                <span className="text-[11px] ml-auto" style={{ color: "var(--fg-tertiary)" }}>已选 {selectedIds.size} 项</span>
                <Button variant="destructive" size="sm" className="text-[11px] px-2" disabled={selectedIds.size === 0} onClick={handleDeleteSelected}>
                  <Trash2 className="w-3 h-3" />
                  删除
                </Button>
                <Button variant="ghost" size="sm" className="text-[11px] px-2" onClick={exitManage}>完成</Button>
              </>
            ) : (
              <>
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--fg-tertiary)" }}>会话列表</span>
                <Button variant="ghost" size="sm" className="text-[11px] px-2 ml-auto" onClick={enterManage} title="批量管理会话">
                  <ListChecks className="w-3.5 h-3.5" />
                  管理
                </Button>
              </>
            )}
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 overflow-y-auto px-2 py-1 scrollbar-custom">
        {!project && <div className="text-xs py-12 text-center" style={{ color: "var(--fg-tertiary)" }}>请先选择一个项目</div>}
        {project && sessions.length === 0 && (
          <div className="text-xs py-12 text-center flex flex-col items-center gap-3" style={{ color: "var(--fg-tertiary)" }}>
            <MessageSquare className="w-6 h-6" style={{ color: "var(--fg-quaternary)" }} />
            <span>暂无会话，开始你的第一次对话吧</span>
            <Button variant="outline" size="sm" className="text-[11px]" onClick={onNewSession}>
              <MessageSquarePlus className="w-3.5 h-3.5" />
              新建会话
            </Button>
          </div>
        )}
        {Object.entries(groupedSessions).map(([group, groupSessions]) => {
          if (groupSessions.length === 0) return null;
          const isExpanded = expandedGroups[group] !== false;
          return (
            <div key={group} className="mb-1">
              <button onClick={() => setExpandedGroups(p => ({ ...p, [group]: !p[group] }))}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md transition-colors hover:bg-muted" style={{ color: "var(--fg-tertiary)" }}>
                <svg className={`w-3 h-3 transition-transform duration-200 ${isExpanded ? "" : "-rotate-90"}`} viewBox="0 0 12 12" fill="none"><path d="M4 3l4 3-4 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {group}
                <span className="ml-auto font-normal" style={{ color: "var(--fg-quaternary)" }}>{groupSessions.length}</span>
              </button>
              {isExpanded && groupSessions.map((session) => {
                const isActive = activeSession === session.session_id;
                // 批量管理模式：复选框条目（点击整行切换选中）
                if (manageMode) {
                  const checked = selectedIds.has(session.session_id);
                  return (
                    <div key={session.session_id}
                      onClick={() => toggleSelect(session.session_id)}
                      className={`flex items-center gap-2 rounded-lg text-sm cursor-pointer px-2 py-1.5 transition-colors ${checked ? "bg-muted" : "sidebar-item hover:bg-muted/50"}`}>
                      <div className="w-4 h-4 rounded shrink-0 flex items-center justify-center border" style={{ borderColor: checked ? "var(--success)" : "var(--border)", background: checked ? "var(--success)" : "transparent" }}>
                        {checked && <Check className="w-3 h-3" style={{ color: "var(--bg)" }} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate" style={{ color: "var(--fg)" }}>{session.title || "新会话"}</div>
                        <div className="text-[10px] mt-0.5 truncate" style={{ color: "var(--fg-tertiary)" }}>{session.message_count || 0} 条 · {formatTime(session.updated_at)}</div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={session.session_id} className={`group flex items-center rounded-lg text-sm ${isActive ? "active sidebar-item" : "sidebar-item"}`}>
                    <button onClick={() => onSessionChange(session.session_id)} className="flex-1 text-left min-w-0">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: isActive ? "var(--bg-tertiary)" : "var(--bg)" }}>
                          {session.kind === "task" ? <FileText className="w-3.5 h-3.5" /> : <MessageSquare className="w-3.5 h-3.5" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <SessionTitle session={session} onRename={handleRename} onSessionChange={onSessionChange} />
                          <div className="text-[10px] mt-0.5 flex items-center gap-1.5" style={{ color: "var(--fg-tertiary)" }}>
                            {isSessionRunning(session.session_id) && (
                              <span className="flex items-center gap-1" style={{ color: "var(--success)" }}>
                                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--success)" }} />
                                运行中
                              </span>
                            )}
                            <span>{session.message_count || 0} 条 · {formatTime(session.updated_at)}</span>
                            {session.cost ? ` · ${formatCost(session.cost)}` : ""}
                          </div>
                        </div>
                      </div>
                    </button>
                    <Button variant="ghost" size="icon" onClick={async (e) => { e.stopPropagation(); disposeSession(session.session_id); try { await SessionService.delete(session.session_id); loadSessions(); } catch { /* ignore */ } if (activeSession === session.session_id) onNewSession(); }}
                      className="h-6 w-6 p-0 mr-1 rounded-md opacity-0 group-hover:opacity-100 transition-all shrink-0">
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      </div>
    </div>
  );
}

export function Sidebar(props: Props) {
  if (!props.open) return null;
  return (
    <>
      <div className="overlay" onClick={props.onClose} />
      <div className="drawer">
        <SidebarContent {...props} />
      </div>
    </>
  );
}
