import { ipcMain, shell } from "electron"
import { getServerManager } from "./sidecar-bridge"

/** Skill / 扩展 IPC — 经 sidecar HTTP 代理到 ctx.skill / ctx.mcp 服务（插件注册目录即时生效） */
function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not started")
  return m
}

export function registerSkillIPC(): void {
  /** 仅启用 skill（聊天斜杠命令面板用，行为兼容） */
  ipcMain.handle("skill:listSkills", async () => {
    return (await sm().request("GET", "/api/skills")) as Array<{
      name: string
      description: string
      category?: string
    }>
  })

  /** 全量 skill（设置页「扩展」：含禁用项 + 来源/路径/命名校验） */
  ipcMain.handle("skill:listAll", async () => {
    return (await sm().request("GET", "/api/skills/all")) as Array<{
      name: string
      description: string
      category?: string
      path: string
      source: string
      enabled: boolean
      validName: boolean
    }>
  })

  /** skill 目录清单（内置/用户/插件/全局兼容） */
  ipcMain.handle("skill:listDirs", async () => {
    return (await sm().request("GET", "/api/skills/dirs")) as Array<{
      path: string
      source: string
      exists: boolean
      removable: boolean
    }>
  })

  /** 添加用户 skill 目录（持久化到 skills.json） */
  ipcMain.handle("skill:addDir", async (_e, dir: string) => {
    return (await sm().request("POST", "/api/skills/dirs/add", { dir })) as { success: boolean; error?: string }
  })

  /** 移除用户 skill 目录（只移除注册不删文件） */
  ipcMain.handle("skill:removeDir", async (_e, dir: string) => {
    return (await sm().request("POST", "/api/skills/dirs/remove", { dir })) as { success: boolean; error?: string }
  })

  /** 启用/禁用 skill（写入 skills.json disabled 名单） */
  ipcMain.handle("skill:toggle", async (_e, name: string, enabled: boolean) => {
    return (await sm().request("POST", "/api/skills/toggle", { name, enabled })) as { success: boolean; error?: string }
  })

  /** 卸载 skill（删除其目录，带安全约束） */
  ipcMain.handle("skill:uninstall", async (_e, name: string) => {
    return (await sm().request("POST", "/api/skills/uninstall", { name })) as { success: boolean; error?: string; path?: string }
  })

  /** 导入 skill（zip/.md/文件夹路径，自动安装；高风险返回 needsConfirm，确认后带 confirmed=true 重试；skipRiskCheck 跳过风险确认） */
  ipcMain.handle("skill:import", async (_e, payload: { fileName: string; zipBase64?: string; mdContent?: string; folderPath?: string; confirmed?: boolean; autoInstall?: boolean; skipRiskCheck?: boolean }) => {
    return (await sm().request("POST", "/api/skills/import", payload)) as {
      success: boolean
      needsConfirm?: boolean
      riskLevel: "low" | "high"
      risks: Array<{ level: "info" | "warning"; message: string }>
      name?: string
      path?: string
      error?: string
    }
  })

  /** 在系统文件管理器中打开目录（设置页便捷入口） */
  ipcMain.handle("skill:openPath", async (_e, path: string) => {
    if (!path || typeof path !== "string") return { success: false, error: "缺少 path 参数" }
    const err = await shell.openPath(path)
    return err ? { success: false, error: err } : { success: true }
  })

  /** MCP 服务器连接状态（设置页「扩展」MCP tab） */
  ipcMain.handle("extensions:mcpStatus", async () => {
    return (await sm().request("GET", "/api/extensions/mcp")) as Array<{
      name: string
      connected: boolean
      toolCount: number
    }>
  })

  /** 运行期自修改插件全局列表（设置页「扩展」插件 tab） */
  ipcMain.handle("extensions:plugins", async () => {
    return (await sm().request("GET", "/api/extensions/plugins")) as Array<{
      sessionId: string
      pluginId: string
      packageId: string
      name: string
    }>
  })
}
