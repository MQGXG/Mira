import { app, BrowserWindow, dialog, globalShortcut } from "electron";
import { createWindow, showMainWindow } from "../managers/window-manager";
import { createTray, destroyTray } from "../managers/tray-manager";
import { registerIPCHandlers } from "../ipc/handlers";
import { startSidecar, stopSidecar } from "../ipc/sidecar-bridge";
import { initLogger, patchConsole, getLogFilePath } from "../utils/logger";
import { injectShellEnv } from "../utils/shell-env";
import { initPlatformPaths } from "@mira/core";
import { destroyPetWindow } from "../live2d-pet/pet-manager";
import { join } from "path";

// 强制 GPU 加速 — 虚拟显卡驱动可能阻挡 Intel 核显检测
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-webgl");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "d3d11");
app.commandLine.appendSwitch("disable-direct-composition");

async function initializeApp() {
  // 本地模型资源目录：打包后位于 process.resourcesPath/models，开发时位于仓库内 resources/models
  const modelDir = app.isPackaged
    ? join(process.resourcesPath, "models")
    : join(app.getAppPath(), "resources", "models");
  initPlatformPaths({
    userData: app.getPath("userData"),
    home: app.getPath("home"),
    modelDir,
  })
  injectShellEnv();
  initLogger();
  patchConsole();
  console.log(`[Main] Logger initialized: ${getLogFilePath()}`);

  // 并行启动 Sidecar Core 服务（独立 HTTP 进程），不阻塞窗口创建
  // startSidecar 同步段会先赋值 serverManager，故 registerIPCHandlers 可立即安全注册
  console.log("[Main] Starting Core Sidecar server (async)...");
  const sidecarPromise = startSidecar(0);

  registerIPCHandlers();

  // 主窗口立即创建，启动加载动画覆盖首屏，期间 Sidecar 在后台完成初始化
  await createWindow();
  createTray();

  // 等待 Sidecar 就绪（渲染层首屏动画期间完成，ready 后数据加载自然放行）
  try {
    await sidecarPromise;
    console.log("[Main] Core Sidecar server ready");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Main] Core Sidecar failed to start: ${message}`);
    dialog.showErrorBox("Mira 启动失败", `Core 服务无法启动：${message}`);
    app.quit();
    return;
  }

  globalShortcut.register("CommandOrControl+Shift+A", () => {
    showMainWindow();
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}

// 单实例锁：二次启动时激活已有窗口并退出新实例，避免开发时多实例/多托盘图标
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    } else {
      showMainWindow();
    }
  });
}

app.whenReady().then(initializeApp);

app.on("before-quit", async () => {
  globalShortcut.unregisterAll();
  destroyPetWindow();
  destroyTray();
  await stopSidecar();
});
