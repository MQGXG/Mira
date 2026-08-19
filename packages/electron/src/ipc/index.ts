import { registerSidecarIPCHandlers } from "./sidecar-bridge"
import { registerSessionIPC } from "./session-ipc"
import { registerConfigIPC } from "./config-ipc"
import { registerTaskIPC } from "./task-ipc"
import { registerSubagentIPC } from "./subagent-ipc"
import { registerGoalIPC } from "./goal-ipc"
import { registerDreamIPC } from "./dream-ipc"
import { registerComposeIPC } from "./compose-ipc"
import { registerSkillIPC } from "./skill-ipc"
import { registerQuestionIPC } from "./question-ipc"
import { registerMemoryIPC } from "./memory-ipc"
import { registerSelfModIPC } from "./selfmod-ipc"
import { registerLive2dIPC } from "./live2d-ipc"
import { registerGraphIPC } from "./graph-ipc"
import { setupDefaultHooks, cronScheduler } from "@mira/core"

export function registerAgentIPCHandlers(): void {
  setupDefaultHooks()
  cronScheduler.start()

  // Agent 操作 → Sidecar HTTP 代理
  registerSidecarIPCHandlers()

  // 其他 IPC（直连 Electron API，无需 Sidecar）
  registerSessionIPC()
  registerConfigIPC()
  registerTaskIPC()
  registerSubagentIPC()
  registerGoalIPC()
  registerDreamIPC()
  registerComposeIPC()
  registerSkillIPC()
  registerQuestionIPC()
  registerMemoryIPC()
  registerSelfModIPC()
  registerLive2dIPC()
  registerGraphIPC()
}

