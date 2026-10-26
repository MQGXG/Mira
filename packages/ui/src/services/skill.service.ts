/**
 * Skill Service — 扩展管理（设置页「扩展」用）
 * 封装 skill IPC：全量列表/目录管理/启用禁用 + MCP/插件状态
 */

export interface SkillEntry {
  name: string;
  description: string;
  category?: string;
  path: string;
  /** 来源：mira 全局 / user 用户目录 / project-* 项目级 / opencode·claude·agents 全局兼容 */
  source: string;
  enabled: boolean;
  /** name 是否符合 OpenCode Agent Skills 规范 */
  validName: boolean;
}

export interface SkillDirEntry {
  path: string;
  source: string;
  exists: boolean;
  removable: boolean;
}

export interface McpStatusEntry {
  name: string;
  connected: boolean;
  toolCount: number;
}

export interface SelfmodPluginEntry {
  sessionId: string;
  pluginId: string;
  packageId: string;
  name: string;
}

export interface SkillImportResult {
  success: boolean;
  /** true = 检测到高风险，需展示风险清单并让用户确认后带 confirmed=true 重试 */
  needsConfirm?: boolean;
  riskLevel: "low" | "high";
  risks: Array<{ level: "info" | "warning"; message: string }>;
  name?: string;
  path?: string;
  error?: string;
}

export const SkillService = {
  /** 全量 skill（含禁用项） */
  async listAll(): Promise<SkillEntry[]> {
    return window.electronAPI.skill.listAll();
  },

  /** 目录清单 */
  async listDirs(): Promise<SkillDirEntry[]> {
    return window.electronAPI.skill.listDirs();
  },

  /** 添加用户 skill 目录 */
  async addDir(dir: string): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.skill.addDir(dir);
  },

  /** 移除用户 skill 目录（不删磁盘文件） */
  async removeDir(dir: string): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.skill.removeDir(dir);
  },

  /** 启用/禁用 skill */
  async setEnabled(name: string, enabled: boolean): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.skill.setEnabled(name, enabled);
  },

  /** 卸载 skill（删除其目录） */
  async uninstall(name: string): Promise<{ success: boolean; error?: string; path?: string }> {
    return window.electronAPI.skill.uninstall(name);
  },

  /** 导入 skill（zip/.md/文件夹，自动安装；高风险或 autoInstall=false 返回 needsConfirm；skipRiskCheck 跳过风险确认） */
  async importSkill(payload: {
    fileName: string;
    zipBase64?: string;
    mdContent?: string;
    folderPath?: string;
    confirmed?: boolean;
    autoInstall?: boolean;
    skipRiskCheck?: boolean;
  }): Promise<SkillImportResult> {
    return window.electronAPI.skill.import(payload);
  },

  /** 在系统文件管理器中打开目录 */
  async openPath(path: string): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.skill.openPath(path);
  },

  /** MCP 服务器连接状态 */
  async mcpStatus(): Promise<McpStatusEntry[]> {
    return window.electronAPI.skill.mcpStatus();
  },

  /** 运行期自修改插件全局列表 */
  async plugins(): Promise<SelfmodPluginEntry[]> {
    return window.electronAPI.skill.plugins();
  },
};
