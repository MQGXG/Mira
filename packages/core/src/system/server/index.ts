/**
 * Sidecar 服务器 — 作为独立进程运行 @mira/core
 *
 * 使用方式:
 *   node dist/server/index.js --port 3456
 *   或通过 ServerManager 由 Electron 自动管理
 */

export { createServer, startServer, type ServerOptions } from "./server"
export { handleStartStream, handlePermissionReply, handleStopStream, handleListTools, handleListAgents, handleExecuteTool, handleExecuteBatch, handleMemorySearch, handleMemoryStatus } from "./api"
export type { APIContext } from "./api"
