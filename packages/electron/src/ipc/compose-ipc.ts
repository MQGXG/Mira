import { ipcMain } from "electron"
import { ComposeModeManager, type ComposePhase, type ComposeState } from "@mira/core"

const composeModeManager = new ComposeModeManager()

export function registerComposeIPC(): void {
  ipcMain.handle("compose:start", (_, spec: string) => {
    return composeModeManager.start(spec)
  })
  ipcMain.handle("compose:getState", () => {
    return composeModeManager.getState()
  })
  ipcMain.handle("compose:getCurrentSkill", () => {
    return composeModeManager.getCurrentSkill()
  })
  ipcMain.handle("compose:advance", () => {
    return composeModeManager.advance()
  })
  ipcMain.handle("compose:goTo", (_, phase: ComposePhase) => {
    return composeModeManager.goTo(phase)
  })
  ipcMain.handle("compose:update", (_, updates: Partial<ComposeState>) => {
    composeModeManager.update(updates)
    return true
  })
  ipcMain.handle("compose:addCodeFile", (_, filePath: string) => {
    composeModeManager.addCodeFile(filePath)
    return true
  })
  ipcMain.handle("compose:addReviewComment", (_, comment: string) => {
    composeModeManager.addReviewComment(comment)
    return true
  })
  ipcMain.handle("compose:addTestResult", (_, result: string) => {
    composeModeManager.addTestResult(result)
    return true
  })
  ipcMain.handle("compose:addDebugLog", (_, log: string) => {
    composeModeManager.addDebugLog(log)
    return true
  })
  ipcMain.handle("compose:setVerificationPassed", (_, passed: boolean) => {
    composeModeManager.setVerificationPassed(passed)
    return true
  })
  ipcMain.handle("compose:complete", () => {
    return composeModeManager.complete()
  })
  ipcMain.handle("compose:cancel", () => {
    return composeModeManager.cancel()
  })
  ipcMain.handle("compose:getHistory", () => {
    return composeModeManager.getHistory()
  })
  ipcMain.handle("compose:toText", () => {
    return composeModeManager.toText()
  })
  ipcMain.handle("compose:getSkills", () => {
    return ComposeModeManager.getSkills()
  })
  ipcMain.handle("compose:getPhaseOrder", () => {
    return ComposeModeManager.getPhaseOrder()
  })
}
