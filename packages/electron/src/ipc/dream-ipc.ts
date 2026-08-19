import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"
import type { LLMMessage } from "@mira/core"

/** Dream/Distill IPC — 经 sidecar HTTP 代理到 ctx.dream 服务（消除主进程双实例） */
function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not started")
  return m
}

export function registerDreamIPC(): void {
  ipcMain.handle("dreamDistill:dream", async (_, conversationHistory: LLMMessage[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) => {
    return (await sm().request("POST", "/api/dream/dream", { conversationHistory, config })) as unknown
  })
  ipcMain.handle("dreamDistill:distill", async (_, conversationHistory: LLMMessage[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) => {
    return (await sm().request("POST", "/api/dream/distill", { conversationHistory, config })) as {
      timestamp: string
      workflowsFound: unknown[]
      summary: string
    }
  })
  ipcMain.handle("dreamDistill:getKnowledge", async () => {
    return (await sm().request("GET", "/api/dream/knowledge")) as unknown[]
  })
  ipcMain.handle("dreamDistill:toText", async () => {
    return ((await sm().request("GET", "/api/dream/toText")) as { text: string }).text
  })
}