import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

/** Skill IPC — 经 sidecar HTTP 代理到 ctx.skill 服务（插件注册目录即时生效） */
function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not started")
  return m
}

export function registerSkillIPC(): void {
  ipcMain.handle("skill:listSkills", async () => {
    return (await sm().request("GET", "/api/skills")) as Array<{
      name: string
      description: string
      category?: string
    }>
  })
}