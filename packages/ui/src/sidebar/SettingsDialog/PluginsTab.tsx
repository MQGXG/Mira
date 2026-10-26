/**
 * PluginsTab — 「扩展」页插件 tab（只读）
 * 展示运行期自修改插件（Agent 经 mira_plugin_* 工具定义/激活的动态插件，按会话聚合）
 */

import { useEffect, useState } from "react";
import { Puzzle, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { SkillService, type SelfmodPluginEntry } from "../../services/skill.service";

export function PluginsTab() {
  const [plugins, setPlugins] = useState<SelfmodPluginEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setPlugins(await SkillService.plugins());
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
        <div className="text-xs text-secondary">
          运行期自修改插件：Agent 在会话中经 mira_plugin_* 工具定义、持久化并激活自己的插件
        </div>
        <Button variant="ghost" size="icon" onClick={refresh} title="刷新" className="h-7 w-7 shrink-0">
          <RefreshCw className={`w-3.5 h-3.5 text-secondary ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-xs text-tertiary">已定义的插件</div>
        <div className="rounded-xl bg-surface-secondary border border-standard divide-y divide-standard">
          {loading && plugins.length === 0 ? (
            <div className="text-xs text-tertiary py-6 text-center">加载中…</div>
          ) : plugins.length === 0 ? (
            <div className="text-xs text-tertiary py-6 text-center">
              还没有插件。在对话中让 Agent 使用 mira_plugin_define 创建，或用 mira_plugin_list 查看。
            </div>
          ) : (
            plugins.map((p) => (
              <div key={`${p.sessionId}:${p.pluginId}`} className="flex items-center gap-3 px-4 py-3">
                <Puzzle className="w-3.5 h-3.5 text-secondary shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-primary font-mono truncate">{p.name}</div>
                  <div className="text-[10px] text-tertiary truncate mt-0.5">会话 {p.sessionId}</div>
                </div>
                <span className="text-[10px] font-mono text-tertiary shrink-0">{p.packageId}</span>
              </div>
            ))
          )}
        </div>
        <div className="text-[10px] text-tertiary">插件的定义、运行、停止与卸载均通过对话中的 Agent 工具完成（经 VM 沙箱 + 审批门执行）。</div>
      </div>
    </div>
  );
}
