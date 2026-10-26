/**
 * SkillsTab — 「扩展」页技能 tab
 * 列表：按来源分组（Mira 全局/用户目录/项目级/全局兼容），行内 Switch 启用禁用 + 打开目录 + 卸载（两步确认）
 * 目录管理：已注册目录展示（用户目录可移除）+ 添加目录（持久化到 skills.json）
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, FolderOpen, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { Switch } from "../../components/ui/switch";
import { Button } from "../../components/ui/button";
import { DialogService } from "../../services/dialog.service";
import { SkillService, type SkillDirEntry, type SkillEntry } from "../../services/skill.service";
import { ImportSkillDialog } from "./ImportSkillDialog";

/** 来源分组顺序与展示名 */
const SOURCE_GROUPS: Array<{ id: string; label: string; match: (s: string) => boolean }> = [
  { id: "mira", label: "Mira 全局", match: (s) => s === "mira" },
  { id: "user", label: "用户目录", match: (s) => s === "user" },
  { id: "project", label: "项目级（.opencode / .claude / .agents）", match: (s) => s.startsWith("project-") },
  { id: "compat", label: "全局兼容目录（OpenCode / Claude / Agents）", match: (s) => s === "opencode" || s === "claude" || s === "agents" },
];

const SOURCE_BADGES: Record<string, string> = {
  mira: "Mira",
  user: "用户",
  "project-opencode": "项目 · opencode",
  "project-claude": "项目 · claude",
  "project-agents": "项目 · agents",
  opencode: "opencode",
  claude: "claude",
  agents: "agents",
};

const DIR_SOURCE_LABELS: Record<string, string> = {
  mira: "内置",
  user: "用户目录",
  plugin: "插件注册",
  compat: "全局兼容",
};

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [dirs, setDirs] = useState<SkillDirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  /** 待确认卸载的 skill 名（两步确认防误删：第一次点击进入确认态，再次点击执行） */
  const [confirmingUninstall, setConfirmingUninstall] = useState<string | null>(null);
  /** 导入对话框开关 */
  const [showImport, setShowImport] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, dirList] = await Promise.all([SkillService.listAll(), SkillService.listDirs()]);
      setSkills(list);
      setDirs(dirList);
    } catch {
      // sidecar 未就绪时静默（列表保持空）
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /** 启用/禁用开关（乐观更新，失败回滚刷新） */
  async function toggleSkill(name: string, enabled: boolean) {
    setSkills((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
    const result = await SkillService.setEnabled(name, enabled);
    if (!result.success) refresh();
  }

  /** 添加用户 skill 目录（选择文件夹 → 持久化 → 刷新） */
  async function addDir() {
    const picked = await DialogService.openDirectory();
    if (!picked || picked.length === 0) return;
    setBusy(true);
    try {
      const result = await SkillService.addDir(picked[0]);
      if (!result.success && result.error) alert(result.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /** 移除用户目录（只移除注册，不删磁盘文件） */
  async function removeDir(path: string) {
    setBusy(true);
    try {
      const result = await SkillService.removeDir(path);
      if (!result.success && result.error) alert(result.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  /** 卸载 skill（删除其目录）——两步确认：确认态中再次点击才执行 */
  async function uninstallSkill(name: string) {
    if (confirmingUninstall !== name) {
      setConfirmingUninstall(name);
      return;
    }
    setConfirmingUninstall(null);
    setBusy(true);
    try {
      const result = await SkillService.uninstall(name);
      if (!result.success) alert(result.error ?? "卸载失败");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const grouped = SOURCE_GROUPS.map((g) => ({
    ...g,
    items: skills.filter((s) => g.match(s.source)),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-6">
      {/* 头部：标题 + 操作入口 */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-medium text-primary">技能</div>
          <div className="text-xs text-secondary mt-0.5">管理可用的技能（Skill），禁用后不会进入斜杠命令与 Agent 工具列表</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" onClick={() => setShowImport(true)} className="h-7 text-xs gap-1.5">
            <Upload className="w-3.5 h-3.5" /> 导入
          </Button>
          <Button variant="ghost" size="icon" onClick={refresh} title="刷新" className="h-7 w-7">
            <RefreshCw className={`w-3.5 h-3.5 text-secondary ${loading ? "animate-spin" : ""}`} />
          </Button>
          {dirs[0]?.path && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => SkillService.openPath(dirs[0].path)}
              className="h-7 text-xs text-secondary gap-1.5"
            >
              <FolderOpen className="w-3.5 h-3.5" /> 在目录中管理
            </Button>
          )}
        </div>
      </div>

      {/* 按来源分组的 skill 列表 */}
      {loading && skills.length === 0 ? (
        <div className="text-xs text-tertiary py-6 text-center">加载中…</div>
      ) : grouped.length === 0 ? (
        <div className="text-xs text-tertiary py-6 text-center">
          没有发现技能。点击右上角「导入」安装 .zip/.md，或在 ~/.config/mira/skills/&lt;分类&gt;/&lt;名称&gt;/SKILL.md 创建。
        </div>
      ) : (
        <div className="space-y-5">
          {grouped.map((g) => (
            <div key={g.id} className="space-y-2">
              <div className="text-xs text-tertiary">{g.label}</div>
              <div className="rounded-xl bg-surface-secondary border border-standard divide-y divide-standard">
                {g.items.map((s) => (
                  <div key={s.name} className="group flex items-center gap-3 px-4 py-3">
                    <span className="text-xs font-mono text-secondary shrink-0" title={SOURCE_BADGES[s.source] ?? s.source}>
                      ⛓
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-primary font-mono truncate">{s.name}</span>
                        {!s.validName && (
                          <span title="名称不符合 OpenCode 规范（小写字母数字 + 单连字符），可能无法被其他工具发现">
                            <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                          </span>
                        )}
                        {s.category && <span className="text-[10px] text-tertiary shrink-0">[{s.category}]</span>}
                      </div>
                      {s.description && (
                        <div className="text-xs text-secondary truncate mt-0.5" title={s.description}>
                          {s.description}
                        </div>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => SkillService.openPath(s.path)}
                      title="打开 skill 目录"
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <ExternalLink className="w-3.5 h-3.5 text-secondary" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => uninstallSkill(s.name)}
                      onMouseLeave={() => setConfirmingUninstall((cur) => (cur === s.name ? null : cur))}
                      disabled={busy}
                      title={confirmingUninstall === s.name ? "再次点击确认删除该 skill 目录" : "卸载（删除 skill 目录）"}
                      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <Trash2
                        className={`w-3.5 h-3.5 transition-colors ${
                          confirmingUninstall === s.name ? "text-red-500" : "text-secondary hover:text-red-500"
                        }`}
                      />
                    </Button>
                    <Switch checked={s.enabled} onCheckedChange={(v) => toggleSkill(s.name, v)} aria-label={`启用 ${s.name}`} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 目录管理 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs text-tertiary">扫描目录</div>
          <Button variant="ghost" size="sm" onClick={addDir} disabled={busy} className="h-7 text-xs gap-1.5">
            <Plus className="w-3.5 h-3.5" /> 添加目录
          </Button>
        </div>
        <div className="rounded-xl bg-surface-secondary border border-standard divide-y divide-standard">
          {dirs.map((d) => (
            <div key={`${d.source}:${d.path}`} className="group flex items-center gap-3 px-4 py-2.5">
              <span className="text-[10px] text-tertiary shrink-0 w-16">{DIR_SOURCE_LABELS[d.source] ?? d.source}</span>
              <span className="text-xs font-mono text-secondary truncate flex-1" title={d.path}>{d.path}</span>
              {!d.exists && <span className="text-[10px] text-tertiary shrink-0">不存在</span>}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => SkillService.openPath(d.path)}
                title="打开目录"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <ExternalLink className="w-3 h-3 text-secondary" />
              </Button>
              {d.removable && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeDir(d.path)}
                  disabled={busy}
                  title="移除该目录注册（不删除磁盘文件）"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-3 h-3 text-secondary hover:text-red-500" />
                </Button>
              )}
            </div>
          ))}
        </div>
        <div className="text-[10px] text-tertiary">
          技能发现位置兼容 OpenCode Agent Skills 标准：项目级 .opencode/.claude/.agents（向上遍历到 git 根）与全局 ~/.config/opencode、~/.claude、~/.agents。
        </div>
      </div>

      {/* 导入技能对话框（zip/.md 拖拽上传，自动解压安装） */}
      <ImportSkillDialog open={showImport} onClose={() => setShowImport(false)} onImported={refresh} />
    </div>
  );
}
