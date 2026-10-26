/**
 * ExtensionsPanel — 设置页「扩展」大页
 * 三个分段 tab：MCP（服务器连接状态）/ 插件（运行期自修改插件）/ 技能（Skill 管理，含启用禁用与目录管理）
 * 视觉对齐 OpenCode「扩展」设置页：列表行 + 右侧开关
 */

import { useState } from "react";
import { McpTab } from "./McpTab";
import { PluginsTab } from "./PluginsTab";
import { SkillsTab } from "./SkillsTab";

type ExtensionsTab = "mcp" | "plugins" | "skills";

const TABS: Array<{ id: ExtensionsTab; label: string }> = [
  { id: "mcp", label: "MCP" },
  { id: "plugins", label: "插件" },
  { id: "skills", label: "技能" },
];

export function ExtensionsPanel() {
  const [tab, setTab] = useState<ExtensionsTab>("skills");

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-primary">扩展</h3>
        <p className="text-xs text-secondary mt-1">管理此应用可用的扩展</p>
      </div>

      {/* 分段 tab 控件 */}
      <div className="flex items-center gap-1 p-1 rounded-lg w-fit bg-surface-secondary border border-standard">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="px-3.5 py-1.5 text-xs rounded-md transition-colors"
            style={{
              background: tab === t.id ? "var(--primary)" : "transparent",
              color: tab === t.id ? "var(--background, #fff)" : "var(--text-secondary)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "mcp" && <McpTab />}
      {tab === "plugins" && <PluginsTab />}
      {tab === "skills" && <SkillsTab />}
    </div>
  );
}
