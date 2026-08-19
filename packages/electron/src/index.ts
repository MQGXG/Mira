/**
 * @mira/electron - Electron 主进程包
 *
 * 包含 Electron 主进程、预加载脚本、IPC 通信
 */

// ─── 主进程 ────────────────────────────────────────────────────
export { createWindow, showMainWindow } from "./managers/window-manager"
export { createTray } from "./managers/tray-manager"

// ─── IPC 处理 ──────────────────────────────────────────────────
export { registerIPCHandlers } from "./ipc/handlers"

// ─── 工具函数 ──────────────────────────────────────────────────
export { initLogger, patchConsole, getLogFilePath } from "./utils/logger"
export { injectShellEnv } from "./utils/shell-env"
