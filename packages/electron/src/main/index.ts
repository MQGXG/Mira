import { app, BrowserWindow, dialog, globalShortcut } from "electron";
import { createWindow, showMainWindow } from "../managers/window-manager";
import { createTray, destroyTray } from "../managers/tray-manager";
import { registerIPCHandlers } from "../ipc/handlers";
import { startRendererBootWindow, rearmRendererBootWindow, disposeRendererBootWindow } from "../ipc/renderer-boot";
import { startSidecar, stopSidecar } from "../ipc/sidecar-bridge";
import { initLogger, patchConsole, getLogFilePath } from "../utils/logger";
import { injectShellEnv } from "../utils/shell-env";
import { initPlatformPaths } from "@mira/core";
import { readLastRun, clearCrashMarker, defaultCrashStatePath } from "@mira/core/system/crash-evidence";
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

  // 读取 sidecar 上次运行残留（判定异常退出）。
  // 必须在 startSidecar 之前：sidecar 启动时 beginDesktopRun 会覆盖标记，后移会读到新标记造成假阳性。
  try {
    const last = readLastRun(defaultCrashStatePath(app.getPath("userData")));
    if (last) {
      const detail = "unreadable" in last ? "（标记损坏）" : `（pid=${last.pid}, startedAt=${last.startedAt}）`;
      console.warn(`[Main] Sidecar 上次未干净退出 ${detail}`);
    }
  } catch {
    // 读取失败不阻塞启动
  }

  // 并行启动 Sidecar Core 服务（独立 HTTP 进程），不阻塞窗口创建
  // startSidecar 同步段会先赋值 serverManager，故 registerIPCHandlers 可立即安全注册
  console.log("[Main] Starting Core Sidecar server (async)...");
  const sidecarPromise = startSidecar(0);

  registerIPCHandlers();

  // 主窗口立即创建，启动加载动画覆盖首屏，期间 Sidecar 在后台完成初始化
  const mainWin = await createWindow();
  // 渲染层 boot 计时：30s 内未收到 renderer 就绪上报则弹恢复提示
  startRendererBootWindow();
  // 窗口隐藏到托盘（close 被拦截转 hide）或真实销毁时停止计时，避免后台弹恢复提示；
  // show 时若 renderer 尚未就绪则重武装（renderer 已就绪的 hide→show 不重复弹）
  mainWin.on("hide", () => disposeRendererBootWindow());
  mainWin.on("closed", () => disposeRendererBootWindow());
  mainWin.on("show", rearmRendererBootWindow);
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
      // 窗口重建后 renderer 重新挂载，对称地重武装 boot 计时
      startRendererBootWindow();
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
  disposeRendererBootWindow();
  destroyPetWindow();
  destroyTray();
  await stopSidecar();
  // win32 下 stopSidecar 用 taskkill /F 终止子进程，sidecar 的 exit 清理不会执行；
  // 此处兜底清除崩溃标记，避免下次启动误报"未干净退出"
  clearCrashMarker(defaultCrashStatePath(app.getPath("userData")));
});
