import { useMemo } from "react";

export interface SettingsTab {
  id: "general" | "shortcuts" | "providers" | "models" | "about";
  label: string;
  keywords: string;
}

export const SETTINGS_TABS: SettingsTab[] = [
  { id: "general", label: "通用", keywords: "通用设置 外观 权限 终端 时间线 进度条 界面" },
  { id: "shortcuts", label: "快捷键", keywords: "快捷键 唤出 新建 会话 发送" },
  { id: "providers", label: "提供商", keywords: "提供商 OpenAI Claude DeepSeek Ollama API Key" },
  { id: "models", label: "模型", keywords: "模型 启用 禁用 搜索" },
  { id: "about", label: "关于", keywords: "关于 版本 技术栈" },
];

export function useSettingsSearch(query: string) {
  return useMemo(() => {
    const matchTab = (tab: SettingsTab) => {
      if (!query) return true;
      return tab.label.includes(query) || tab.keywords.includes(query);
    };

    const filtered = SETTINGS_TABS.filter(matchTab);
    const hasResult = filtered.length > 0;

    return { matchTab, filtered, hasResult };
  }, [query]);
}
