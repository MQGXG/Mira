import { lazy, Suspense, useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { ChatWindow } from "@mira/ui/chat/ChatWindow";
import { Sidebar } from "@mira/ui/sidebar/Sidebar";
import { NewProjectDialog } from "@mira/ui/sidebar/NewProjectDialog";
import { EditProjectDialog } from "@mira/ui/sidebar/EditProjectDialog";
import { SettingsDialog } from "@mira/ui/sidebar/SettingsDialog";
import { Menu, Plus, Settings, Network } from "lucide-react";
import { Button } from "@mira/ui/components/ui/button";
import { CommandPalette } from "@mira/ui/components/CommandPalette";
import { StartupOverlay } from "./components/StartupOverlay";
import { setActiveSessionId } from "@mira/ui/hooks/session-runtime-store";
import { DEFAULT_PROJECT_COLOR } from "@mira/ui";

const GraphPanel = lazy(() => import("@mira/ui/memory/GraphPanel").then((module) => ({ default: module.GraphPanel })));

interface Project {
  project_id: string;
  name: string;
  workspace_path: string;
  color: string;
}

/** 是否为根目录工作区（旧版默认项目误用 C:\ 或 /） */
function isRootWorkspace(p: string): boolean {
  if (!p) return false;
  const t = p.trim().replace(/[\\/]+$/, "");
  return /^[a-zA-Z]:$/.test(t) || t === "";
}

/** 默认工作目录：设置 > 系统默认（Documents/Mira） */
async function getDefaultPath(): Promise<string> {
  try {
    const s = JSON.parse(localStorage.getItem("settings") || "{}") as { defaultWorkspace?: string };
    if (s.defaultWorkspace) return s.defaultWorkspace;
  } catch { /* ignore */ }
  try {
    return (await window.electronAPI.ts.getDefaultWorkspace()) || "";
  } catch {
    return "";
  }
}

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState("");
  const [activeSession, setActiveSession] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 启动状态：首帧完成后结束遮罩，项目数据在后台加载
  const [booted, setBooted] = useState(false);
  // Core sidecar 断连遮罩：reconnecting 时显示"连接中断，正在重连"
  const [sidecarReconnecting, setSidecarReconnecting] = useState(false);
  const sidecarWasDown = useRef(false);

  const loadProjects = useCallback(async () => {
    try {
      const defaultPath = await getDefaultPath();
      const tsProjects = await window.electronAPI.ts.listProjects();
      if (tsProjects && tsProjects.length > 0) {
        // 迁移：旧版默认项目使用根目录（C:\ 或 /），自动更新到新默认路径
        for (const p of tsProjects) {
          if (defaultPath && isRootWorkspace(p.workspace_path)) {
            await window.electronAPI.ts.updateProject(p.project_id, { workspace_path: defaultPath }).catch(() => {});
          }
        }
        const colorMap = JSON.parse(localStorage.getItem("project_colors") || "{}") as Record<string, string>;
        const hidden = JSON.parse(localStorage.getItem("hidden_projects") || "[]") as string[];
        const mapped: Project[] = tsProjects
          .filter((p) => !hidden.includes(p.project_id))
          .map((p) => ({
            project_id: p.project_id,
            name: p.name,
            workspace_path: defaultPath && isRootWorkspace(p.workspace_path) ? defaultPath : p.workspace_path,
            color: colorMap[p.project_id] || DEFAULT_PROJECT_COLOR,
          }));
        setProjects(mapped);
        if (!activeProject) setActiveProject(mapped[0].project_id);
        return;
      }
    } catch { /* fallback */ }

    // 数据库为空或连接失败时，只创建一次默认项目（幂等：同名同路径会复用）
    const defaultPath = await getDefaultPath();
    const defaultName = "默认项目";
    try {
      const created = await window.electronAPI.ts.createProject(defaultName, defaultPath);
      const defaultProject: Project = {
        project_id: created.project_id, name: defaultName,
        workspace_path: defaultPath, color: DEFAULT_PROJECT_COLOR,
      };
      setProjects([defaultProject]);
      if (!activeProject) setActiveProject(defaultProject.project_id);
    } catch { /* 静默 */ }
  }, [activeProject]);

  // 首屏渲染与项目数据加载并行，避免 sidecar/数据库初始化阻塞整个界面
  useEffect(() => {
    let active = true;
    void loadProjects();
    const frame = requestAnimationFrame(() => { if (active) setBooted(true); });
    const timer = setInterval(loadProjects, 15000);
    return () => { active = false; cancelAnimationFrame(frame); clearInterval(timer); };
  }, [loadProjects]);

  // 启动时检查桌宠/悬浮球设置
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("settings") || "{}");
      if (s.live2dPet) {
        window.electronAPI.live2d.toggle(true);
      }
      if (s.floatingBallEnabled !== false) {
        window.electronAPI.floatingBall.toggle(true);
      }
    } catch { /* ignore */ }
  }, []);

  // 监听 Core sidecar 连接状态：断连显示遮罩，恢复后刷新项目列表
  // （会话列表由 useSessions 10s 轮询自动恢复，无需额外处理）
  useEffect(() => {
    const off = window.electronAPI.onSidecarStatus((status) => {
      if (status === "reconnecting") {
        sidecarWasDown.current = true;
        setSidecarReconnecting(true);
      } else if (status === "connected") {
        if (sidecarWasDown.current) {
          sidecarWasDown.current = false;
          void loadProjects();
        }
        setSidecarReconnecting(false);
      }
    });
    return off;
  }, [loadProjects]);
  useEffect(() => { if (!activeProject && projects.length > 0) setActiveProject(projects[0].project_id); }, [projects, activeProject]);

  // 同步当前激活会话到运行时 Store（用于后台会话的通知判断）
  useEffect(() => { setActiveSessionId(activeSession); }, [activeSession]);

  // 恢复上次活跃会话（校验会话仍存在，避免恢复已删除会话导致空历史/孤儿数据）
  useEffect(() => {
    if (activeProject) {
      const saved = localStorage.getItem("last_session_" + activeProject);
      if (saved) {
        window.electronAPI.ts.listSessions(activeProject)
          .then((sessions) => {
            const exists = sessions?.some((s: any) => s.session_id === saved);
            if (exists) {
              setActiveSession(saved);
            } else {
              localStorage.removeItem("last_session_" + activeProject);
            }
          })
          .catch(() => setActiveSession(saved));
      }
    }
  }, [activeProject]);
  useEffect(() => {
    if (activeSession) localStorage.setItem("last_session_" + activeProject, activeSession);
  }, [activeSession, activeProject]);

  const handleProjectChange = useCallback((projectId: string) => {
    setActiveProject(projectId);
    setActiveSession("");
    // L4 最近访问记录（用于排序置顶）
    try {
      const map = JSON.parse(localStorage.getItem("project_last_accessed") || "{}") as Record<string, number>;
      map[projectId] = Date.now();
      localStorage.setItem("project_last_accessed", JSON.stringify(map));
    } catch { /* ignore */ }
  }, []);

  // L5 Ctrl/Cmd+1~9 快捷切换项目 + Ctrl/Cmd+K 命令面板
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 1;
        if (projects[idx]) handleProjectChange(projects[idx].project_id);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [projects, handleProjectChange]);

  const handleNewSession = async () => {
    if (!activeProject) return;
    try {
      const session = await window.electronAPI.ts.createSession(activeProject, "");
      if (session?.session_id) setActiveSession(session.session_id);
    } catch { /* ignore */ }
  };

  const handleOpenProject = async (name: string, workspacePath: string) => {
    try {
      const created = await window.electronAPI.ts.createProject(name, workspacePath);
      await loadProjects();
      // 修改点：同路径已存在项目时复用已有项目并跳转过去
      if (created?.project_id) setActiveProject(created.project_id);
      setNewProjectOpen(false);
    } catch { /* ignore */ }
  };

  const handleEditProject = async (projectId: string, name: string, color: string, _startupScript: string) => {
    try {
      await window.electronAPI.ts.updateProject(projectId, { name });
      const colorMap = JSON.parse(localStorage.getItem("project_colors") || "{}");
      colorMap[projectId] = color;
      localStorage.setItem("project_colors", JSON.stringify(colorMap));
      await loadProjects();
    } catch { /* ignore */ }
  };
  const handleDeleteProject = async (projectId: string) => {
    try {
      await window.electronAPI.ts.deleteProject(projectId);
      await loadProjects();
      if (activeProject === projectId) { setActiveProject(""); setActiveSession(""); }
    } catch { /* ignore */ }
  };

  return (
    <div className="h-screen flex flex-col" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      {/* 启动加载动画（数据就绪后自动淡出） */}
      <StartupOverlay visible={!booted} />

      {/* Core 断连遮罩：自动重连中，阻止误操作 */}
      {sidecarReconnecting && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(2px)" }}
        >
          <div
            className="flex items-center gap-3 px-5 py-3 rounded-xl shadow-lg"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--fg)" }}
          >
            <span
              className="inline-block w-4 h-4 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: "var(--accent)" }}
            />
            <span className="text-sm">连接中断，正在重连…</span>
          </div>
        </div>
      )}

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeProject={activeProject}
        activeSession={activeSession}
        projects={projects}
        onProjectChange={handleProjectChange}
        onSessionChange={setActiveSession}
        onNewSession={handleNewSession}
        onOpenProject={() => setNewProjectOpen(true)}
        onEditProject={setEditingProject}
        onDeleteProject={handleDeleteProject}
      />

      <div className="top-bar" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSidebarOpen(true)} title="打开侧边栏">
          <Menu className="h-4 w-4" />
        </Button>

        {/* 项目切换 */}
        <div className="flex items-center gap-1 ml-1">
          {projects.slice(0, 4).map((p) => (
            <button key={p.project_id} onClick={() => handleProjectChange(p.project_id)}
              className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{
                background: activeProject === p.project_id ? "var(--bg-secondary)" : "transparent",
                color: activeProject === p.project_id ? "var(--fg)" : "var(--fg-tertiary)",
              }}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
              <span className="max-w-[80px] truncate">{p.name}</span>
            </button>
          ))}
          {projects.length > 4 && (
            <Button variant="ghost" size="sm" onClick={() => setSidebarOpen(true)} className="text-[11px] px-1.5 text-muted-foreground" style={{ color: "var(--fg-tertiary)" }}>
              +{projects.length - 4}
            </Button>
          )}
        </div>

        <div className="flex-1" />

        <Button onClick={handleNewSession} title="新建会话">
          <Plus className="h-4 w-4" />
          <span>新建会话</span>
        </Button>

        <div className="w-px h-5" style={{ background: "var(--border)" }} />

        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setGraphOpen(true)} title="知识图谱">
          <Network className="h-4 w-4" />
        </Button>

        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSettingsOpen(true)} title="设置">
          <Settings className="h-4 w-4" />
        </Button>

        <div className="flex items-center no-drag">
          <Button variant="ghost" size="icon" className="h-8 w-9 rounded-md" onClick={() => window.electronAPI.minimizeWindow()}>
            <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-9 rounded-md" onClick={() => window.electronAPI.maximizeWindow()}>
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-9 rounded-md text-muted-foreground" onClick={() => window.electronAPI.closeWindow()}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" fill="none" /></svg>
          </Button>
        </div>
      </div>

      <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <ChatWindow sessionId={activeSession} onSessionChange={setActiveSession} onNewSession={handleNewSession}
          workspace={activeProject ? (projects.find(p => p.project_id === activeProject)?.workspace_path || "") : ""} />
      </main>

      {settingsOpen && createPortal(<SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />, document.body)}
      {graphOpen && (
        <Suspense fallback={null}>
          <GraphPanel open={graphOpen} onClose={() => setGraphOpen(false)} projectId={activeProject} projectName={projects.find(p => p.project_id === activeProject)?.name} />
        </Suspense>
      )}
      <NewProjectDialog open={newProjectOpen} onClose={() => setNewProjectOpen(false)} onCreate={handleOpenProject} />
      <EditProjectDialog project={editingProject} open={!!editingProject} onClose={() => setEditingProject(null)} onSave={handleEditProject} onDelete={handleDeleteProject} />
      {paletteOpen && (
        <CommandPalette
          projects={projects}
          activeProject={activeProject}
          onSelectProject={(id) => { handleProjectChange(id); setPaletteOpen(false); }}
          onOpenSession={(id) => { setActiveSession(id); setPaletteOpen(false); }}
          onNewSession={handleNewSession}
          onOpenSettings={() => { setSettingsOpen(true); setPaletteOpen(false); }}
          onOpenGraph={() => { setGraphOpen(true); setPaletteOpen(false); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
