import { ipcMain } from "electron"
import { DreamDistillManager } from "@mira/core"
import type { LLMMessage } from "@mira/core"

const dreamDistillManager = new DreamDistillManager()

export function registerDreamIPC(): void {
  ipcMain.handle("dreamDistill:dream", async (_, conversationHistory: LLMMessage[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) => {
    await dreamDistillManager.initialize(config.apiUrl || process.cwd())
    return await dreamDistillManager.runDream(conversationHistory, config)
  })
  ipcMain.handle("dreamDistill:distill", async (_, conversationHistory: LLMMessage[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) => {
    await dreamDistillManager.initialize(config.apiUrl || process.cwd())
    return (await dreamDistillManager.distill(conversationHistory, config)) as {
      timestamp: string
      workflowsFound: unknown[]
      summary: string
    }
  })
  ipcMain.handle("dreamDistill:getKnowledge", () => {
    return dreamDistillManager.getKnowledge()
  })
  ipcMain.handle("dreamDistill:toText", () => {
    return dreamDistillManager.toText()
  })
}

