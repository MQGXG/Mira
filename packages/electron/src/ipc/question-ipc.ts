import { ipcMain } from "electron"
import { getServerManager } from "./sidecar-bridge"

/**
 * Question IPC — 全部代理到 Sidecar HTTP（Sidecar 单写者）
 * pendingQuestions 位于 sidecar 进程，回答必须落在 sidecar 才能命中，
 * 否则 Agent 提问永远等不到回答（原断链）。
 */

function sm() {
  const m = getServerManager()
  if (!m) throw new Error("Sidecar not running")
  return {
    request: <T = unknown>(method: string, apiPath: string, body?: unknown): Promise<T> =>
      m.request(method, apiPath, body) as Promise<T>,
  }
}

export function registerQuestionIPC(): void {
  ipcMain.handle("question:answer", async (_, questionId: string, answer: string) => {
    return await sm().request("POST", "/api/question/answer", { questionId, answer })
  })

  ipcMain.handle("question:listPending", async () => {
    return await sm().request("GET", "/api/question/pending")
  })
}
