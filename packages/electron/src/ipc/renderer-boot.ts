/**
 * 渲染层 boot 计时窗口 — renderer 首帧就绪上报 + 超时恢复提示
 *
 * 依赖方向：main/index.ts 与 ipc/handlers.ts 都只导入本模块（不互相导入），避免循环依赖。
 * - startRendererBootWindow：main 在 createWindow 后启动 30s 计时
 * - notifyRendererBooted：renderer 经 IPC 上报首帧就绪，取消计时
 * - disposeRendererBootWindow：before-quit 清理
 */

import { app, dialog } from "electron";
import type { MessageBoxOptions } from "electron";
import { rendererBootWindow, RENDERER_BOOT_TIMEOUT_MS } from "@mira/core/system/health";
import { getMainWindow } from "../managers/window-manager";

let windowBootTimer: NodeJS.Timeout | undefined;
let rendererBooted = false;

/** 启动渲染层 boot 计时窗口：超时未收到上报则弹恢复提示（重启走 relaunch） */
export function startRendererBootWindow(): void {
  const bootStartedAt = Date.now();
  rendererBooted = false;
  windowBootTimer = setTimeout(() => {
    if (!rendererBooted && rendererBootWindow(bootStartedAt, Date.now(), RENDERER_BOOT_TIMEOUT_MS)) {
      const options: MessageBoxOptions = {
        type: "warning",
        title: "Mira 界面加载缓慢",
        message: "界面未能按时完成加载，可尝试重启或查看日志。",
        buttons: ["重启", "忽略"],
      };
      const mainWin = getMainWindow();
      void (mainWin ? dialog.showMessageBox(mainWin, options) : dialog.showMessageBox(options))
        .then(({ response }) => {
          // relaunch 不会退出应用，必须配对 exit（不能用 quit：close 拦截依赖 isQuitting，
          // 仅 tray-manager 设置，quit 会被 preventDefault 卡住）
          if (response === 0) {
            app.relaunch();
            app.exit(0);
          }
        })
        .catch(() => {});
    }
  }, RENDERER_BOOT_TIMEOUT_MS + 1000);
}

/** renderer 首帧就绪上报：取消 boot 超时提示 */
export function notifyRendererBooted(): void {
  rendererBooted = true;
  if (windowBootTimer) {
    clearTimeout(windowBootTimer);
    windowBootTimer = undefined;
  }
}

/** 窗口 show 时重武装计时器：仅当 renderer 尚未就绪（避免已上报后再弹误报） */
export function rearmRendererBootWindow(): void {
  if (!rendererBooted) startRendererBootWindow();
}

/** 退出前清理计时器 */
export function disposeRendererBootWindow(): void {
  if (windowBootTimer) {
    clearTimeout(windowBootTimer);
    windowBootTimer = undefined;
  }
}
