import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"
import type { ComposePhase, ComposeState } from "@mira/core"

/** 组合模式 IPC — 全部经 sidecar HTTP 代理到 ctx.compose 服务（消除主进程双实例） */
function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not started")
  return m
}

export function registerComposeIPC(): void {
  ipcMain.handle("compose:start", async (_, spec: string) => {
    return (await sm().request("POST", "/api/compose/start", { spec })) as ComposeState
  })
  ipcMain.handle("compose:getState", async () => {
    return (await sm().request("GET", "/api/compose/state")) as ComposeState | null
  })
  ipcMain.handle("compose:getCurrentSkill", async () => {
    return (await sm().request("GET", "/api/compose/currentSkill")) as unknown
  })
  ipcMain.handle("compose:advance", async () => {
    return (await sm().request("POST", "/api/compose/advance")) as unknown
  })
  ipcMain.handle("compose:goTo", async (_, phase: ComposePhase) => {
    return (await sm().request("POST", "/api/compose/goTo", { phase })) as unknown
  })
  ipcMain.handle("compose:update", async (_, updates: Partial<ComposeState>) => {
    await sm().request("POST", "/api/compose/update", { updates })
    return true
  })
  ipcMain.handle("compose:addCodeFile", async (_, filePath: string) => {
    await sm().request("POST", "/api/compose/addCodeFile", { filePath })
    return true
  })
  ipcMain.handle("compose:addReviewComment", async (_, comment: string) => {
    await sm().request("POST", "/api/compose/addReviewComment", { comment })
    return true
  })
  ipcMain.handle("compose:addTestResult", async (_, result: string) => {
    await sm().request("POST", "/api/compose/addTestResult", { result })
    return true
  })
  ipcMain.handle("compose:addDebugLog", async (_, log: string) => {
    await sm().request("POST", "/api/compose/addDebugLog", { log })
    return true
  })
  ipcMain.handle("compose:setVerificationPassed", async (_, passed: boolean) => {
    await sm().request("POST", "/api/compose/setVerificationPassed", { passed })
    return true
  })
  ipcMain.handle("compose:complete", async () => {
    return (await sm().request("POST", "/api/compose/complete")) as unknown
  })
  ipcMain.handle("compose:cancel", async () => {
    return (await sm().request("POST", "/api/compose/cancel")) as unknown
  })
  ipcMain.handle("compose:getHistory", async () => {
    return (await sm().request("GET", "/api/compose/history")) as ComposeState[]
  })
  ipcMain.handle("compose:toText", async () => {
    return ((await sm().request("GET", "/api/compose/toText")) as { text: string }).text
  })
  ipcMain.handle("compose:getSkills", async () => {
    return (await sm().request("GET", "/api/compose/skills")) as Array<{ name: string; description: string; phase: string; tools: string[] }>
  })
  ipcMain.handle("compose:getPhaseOrder", async () => {
    return (await sm().request("GET", "/api/compose/phaseOrder")) as string[]
  })
}