/**
 * Service 层 — 封装 IPC 调用，解耦 UI 与 Electron
 *
 * 所有组件通过 Service 调用 Electron API，不直接访问 window.electronAPI
 */

export { SessionService } from "./session.service"
export { ProjectService } from "./project.service"
export { AgentService } from "./agent.service"
export { ConfigService } from "./config.service"
export { MemoryService } from "./memory.service"
export { DialogService } from "./dialog.service"
export { GraphService } from "./graph.service"
