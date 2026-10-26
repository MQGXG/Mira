/**
 * McpTab — 「扩展」页 MCP tab（只读）
 * 展示 MCP 服务器连接状态（名称/连接状态/工具数）；配置经 ~/.config/mira 配置文件管理
 */

import { useEffect, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { SkillService, type McpStatusEntry } from "../../services/skill.service";

export function McpTab() {
  const [servers, setServers] = useState<McpStatusEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setServers(await SkillService.mcpStatus());
    } catch {
      // sidecar 未就绪时静默
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="text-xs text-secondary">管理此应用可用的 MCP 服务器</div>
        <Button variant="ghost" size="icon" onClick={refresh} title="刷新" className="h-7 w-7 shrink-0">
          <RefreshCw className={`w-3.5 h-3.5 text-secondary ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs text-tertiary">可用于所有项目</div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-secondary gap-1.5"
            title="MCP 服务器配置在 Mira 配置文件（mira config mcp 段）中管理"
          >
            <FolderOpen className="w-3.5 h-3.5" /> 在配置文件中管理
          </Button>
        </div>
        <div className="rounded-xl bg-surface-secondary border border-standard divide-y divide-standard">
          {loading && servers.length === 0 ? (
            <div className="text-xs text-tertiary py-6 text-center">加载中…</div>
          ) : servers.length === 0 ? (
            <div className="text-xs text-tertiary py-6 text-center">没有已配置的 MCP 服务器</div>
          ) : (
            servers.map((s) => (
              <div key={s.name} className="flex items-center gap-3 px-4 py-3">
                <span className="text-xs text-secondary shrink-0">⛓</span>
                <span className="text-sm font-medium text-primary font-mono flex-1 truncate">{s.name}</span>
                <span className="text-xs text-tertiary shrink-0">{s.toolCount} 个工具</span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                  style={{
                    background: s.connected
                      ? "color-mix(in srgb, #22c55e 15%, transparent)"
                      : "color-mix(in srgb, var(--text-tertiary) 15%, transparent)",
                    color: s.connected ? "#22c55e" : "var(--text-tertiary)",
                  }}
                >
                  {s.connected ? "已连接" : "未连接"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
