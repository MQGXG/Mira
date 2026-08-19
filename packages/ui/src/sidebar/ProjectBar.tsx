import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Plus, FolderOpen } from "lucide-react";
import { Button } from "../components/ui/button";
import { PROJECT_COLORS } from "../theme/data-colors";

interface Project {
  project_id: string;
  name: string;
  workspace_path: string;
  color: string;
}

interface Props {
  projects: Project[];
  activeProject: string;
  onProjectChange: (id: string) => void;
  onOpenProject: () => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
}

const SOLID_COLORS = PROJECT_COLORS;
const UNGROUPED = "未分组";

function getInitial(name: string): string {
  return name?.[0]?.toUpperCase() || "?";
}

// ── localStorage 辅助（项目顺序/最近访问/分组） ──
function getProjectOrder(): string[] {
  try { return JSON.parse(localStorage.getItem("project_order") || "[]") as string[] } catch { return [] }
}
function saveProjectOrder(order: string[]): void {
  localStorage.setItem("project_order", JSON.stringify(order));
}
function getLastAccessed(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem("project_last_accessed") || "{}") as Record<string, number> } catch { return {} }
}
function getProjectGroups(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem("project_groups") || "{}") as Record<string, string> } catch { return {} }
}
function saveProjectGroups(groups: Record<string, string>): void {
  localStorage.setItem("project_groups", JSON.stringify(groups));
}

export function ProjectBar({ projects, activeProject, onProjectChange, onOpenProject, onEditProject, onDeleteProject: _onDeleteProject }: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; project: Project } | null>(null);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  // 拖拽/分组变更后触发重排序
  const [orderVersion, setOrderVersion] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = () => { setContextMenu(null); setShowGroupMenu(false); };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  // 排序：手动顺序优先，否则最近访问置顶
  const sortedProjects = useMemo(() => {
    const order = getProjectOrder();
    const lastAccess = getLastAccessed();
    if (order.length > 0) {
      const orderSet = new Set(order);
      const ordered = order.map(id => projects.find(p => p.project_id === id)).filter(Boolean) as Project[];
      const rest = projects.filter(p => !orderSet.has(p.project_id));
      return [...ordered, ...rest];
    }
    return [...projects].sort((a, b) =>
      (lastAccess[b.project_id] || 0) - (lastAccess[a.project_id] || 0)
    );
  }, [projects, orderVersion]);

  // 分组展示（按组聚合，保持项目顺序）
  const grouped = useMemo(() => {
    const groups = getProjectGroups();
    const groupMap = new Map<string, Project[]>();
    for (const p of sortedProjects) {
      const g = groups[p.project_id] || UNGROUPED;
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g)!.push(p);
    }
    return Array.from(groupMap.entries()).map(([name, items]) => ({ name, items }));
  }, [sortedProjects, orderVersion]);

  const groupNames = useMemo(
    () => Array.from(new Set(Object.values(getProjectGroups()))).filter(n => n),
    [orderVersion],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    setShowGroupMenu(false);
    setNewGroupName("");
    setContextMenu({ x: e.clientX, y: e.clientY, project });
  }, []);

  // ── 拖拽排序（原生 HTML5 DnD） ──
  const handleDragStart = (e: React.DragEvent, projectId: string) => {
    setDragId(projectId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", projectId);
  };
  const handleDragOver = (e: React.DragEvent, projectId: string) => {
    e.preventDefault();
    if (dragOverId !== projectId) setDragOverId(projectId);
  };
  const handleDragEnd = () => { setDragId(null); setDragOverId(null); };
  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const sourceId = dragId || e.dataTransfer.getData("text/plain");
    setDragId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const allIds = sortedProjects.map(p => p.project_id);
    const srcIdx = allIds.indexOf(sourceId);
    const tgtIdx = allIds.indexOf(targetId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    allIds.splice(srcIdx, 1);
    allIds.splice(tgtIdx, 0, sourceId);
    saveProjectOrder(allIds);
    setOrderVersion(v => v + 1);
  };

  // ── 分组操作 ──
  const moveToGroup = (projectId: string, groupName: string) => {
    const groups = getProjectGroups();
    if (groupName === UNGROUPED) delete groups[projectId];
    else groups[projectId] = groupName;
    saveProjectGroups(groups);
    setOrderVersion(v => v + 1);
    setContextMenu(null);
    setShowGroupMenu(false);
  };
  const createGroup = () => {
    const name = newGroupName.trim();
    if (name && contextMenu) moveToGroup(contextMenu.project.project_id, name);
    setNewGroupName("");
  };

  return (
    <div className="w-12 flex flex-col items-center py-3 gap-1.5 shrink-0 overflow-y-auto scrollbar-custom" style={{ background: 'var(--surface)', borderRight: '1px solid var(--sidebar-border)' }}>
      {grouped.map((group, gi) => (
        <div key={group.name} className="flex flex-col items-center gap-1.5 w-full">
          {group.items.map((project) => {
            const isActive = activeProject === project.project_id;
            const bgColor = project.color || SOLID_COLORS[0];
            const icons = JSON.parse(localStorage.getItem("project_icons") || "{}");
            const iconData = icons[project.project_id];
            return (
              <div key={project.project_id} className="relative group">
                <button
                  draggable
                  onDragStart={(e) => handleDragStart(e, project.project_id)}
                  onDragOver={(e) => handleDragOver(e, project.project_id)}
                  onDrop={(e) => handleDrop(e, project.project_id)}
                  onDragEnd={handleDragEnd}
                  onClick={() => onProjectChange(project.project_id)}
                  onContextMenu={(e) => handleContextMenu(e, project)}
                  className={`w-8 h-8 rounded-xl flex items-center justify-center text-white text-[11px] font-bold transition-all duration-200 overflow-hidden ${
                    isActive ? 'ring-2 ring-primary/50 scale-110 shadow-lg' : 'opacity-70 hover:opacity-100 hover:scale-105'
                  } ${dragOverId === project.project_id ? 'ring-2 ring-blue-500/60 scale-110' : ''}`}
                  style={{ background: iconData ? undefined : bgColor, opacity: dragId === project.project_id ? 0.4 : undefined }}
                  title={project.name}
                >
                  {iconData ? (
                    <img src={iconData} alt="" className="w-full h-full object-cover" />
                  ) : (
                    getInitial(project.name)
                  )}
                </button>
                {/* Tooltip */}
                <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 pointer-events-none opacity-0 group-hover:opacity-100 transition-all duration-200 whitespace-nowrap">
                  <div className="px-3 py-2 rounded-xl text-xs shadow-glass-lg" style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                    <div className="font-medium">{project.name}</div>
                    <div className="text-[10px] flex items-center gap-1.5 mt-1" style={{ color: 'var(--text-secondary)' }}>
                      <FolderOpen className="w-2.5 h-2.5" />
                      {project.workspace_path}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {/* 组间分隔线 */}
          {gi < grouped.length - 1 && (
            <div
              className="w-6 h-px my-0.5 shrink-0"
              style={{ background: 'var(--border)' }}
              title={`${grouped[gi + 1].name} 分组`}
            />
          )}
        </div>
      ))}

      <Button variant="ghost" size="icon" onClick={onOpenProject} title="添加项目"
        className="w-8 h-8 rounded-xl mt-1 text-muted-foreground border border-dashed"
        style={{ borderColor: "var(--border)" }}>
        <Plus className="w-4 h-4" />
      </Button>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] rounded-xl overflow-hidden shadow-glass-lg animate-scale-in"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'var(--surface-elevated)',
            border: '1px solid var(--border)',
            minWidth: '160px',
          }}
        >
          <button
            onClick={() => { onEditProject(contextMenu.project); setContextMenu(null); }}
            className="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-muted"
            style={{ color: 'var(--text-primary)' }}
          >
            编辑
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setShowGroupMenu(v => !v); }}
            className="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-muted flex items-center justify-between"
            style={{ color: 'var(--text-primary)' }}
          >
            移动到分组
            <span className="text-[10px]">{showGroupMenu ? "▾" : "▸"}</span>
          </button>
          {showGroupMenu && (
            <div className="border-t" style={{ borderColor: 'var(--border)' }}>
              {groupNames.map((g) => (
                <button key={g} onClick={(e) => { e.stopPropagation(); moveToGroup(contextMenu.project.project_id, g); }}
                  className="w-full text-left px-4 py-2 text-sm transition-colors hover:bg-muted"
                  style={{ color: 'var(--text-primary)' }}>
                  {g}
                </button>
              ))}
              <button onClick={(e) => { e.stopPropagation(); moveToGroup(contextMenu.project.project_id, UNGROUPED); }}
                className="w-full text-left px-4 py-2 text-sm transition-colors hover:bg-muted"
                style={{ color: 'var(--text-tertiary)' }}>
                未分组
              </button>
              <div className="flex items-center gap-1 px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                <input
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") createGroup(); }}
                  placeholder="新建分组..."
                  className="flex-1 min-w-0 text-xs px-2 py-1 rounded outline-none"
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                />
                <button onClick={createGroup} className="px-2 py-1 text-xs rounded transition-colors hover:bg-muted"
                  style={{ color: 'var(--text-secondary)' }}>
                  添加
                </button>
              </div>
            </div>
          )}
          <div style={{ borderTop: '1px solid var(--border)' }} />
          <button
            onClick={() => setContextMenu(null)}
            className="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-muted"
            style={{ color: 'var(--text-primary)' }}
          >
            启用工作区
          </button>
          <button
            onClick={() => setContextMenu(null)}
            className="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-muted"
            style={{ color: 'var(--text-tertiary)' }}
          >
            清除通知
          </button>
          <div style={{ borderTop: '1px solid var(--border)' }} />
          <button
            onClick={() => {
              const hidden = JSON.parse(localStorage.getItem("hidden_projects") || "[]") as string[];
              hidden.push(contextMenu.project.project_id);
              localStorage.setItem("hidden_projects", JSON.stringify(hidden));
              setContextMenu(null);
              window.location.reload();
            }}
            className="w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-muted"
            style={{ color: 'var(--text-primary)' }}
          >
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
