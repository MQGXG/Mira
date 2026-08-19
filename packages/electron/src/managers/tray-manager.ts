import { Tray, Menu, nativeImage, app } from "electron";
import { getMainWindow, showMainWindow } from "./window-manager";
import { join } from "path";
import fs from "fs";

let tray: Tray | null = null;

/** 解析托盘图标路径：打包后位于 process.resourcesPath/icon.png，开发时位于仓库内 resources/icon.png */
function resolveTrayIconPath(): string {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(app.getAppPath(), "resources", "icon.png");
  return fs.existsSync(iconPath) ? iconPath : "";
}

export function createTray(): Tray {
  // 幂等：重复调用（热重载/窗口重建）时复用已有实例，避免托盘图标堆积
  if (tray) return tray;
  const iconPath = resolveTrayIconPath();
  let icon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  // Windows 托盘建议 16/32px；原图过大时按系统缩放（resize 返回新实例）
  if (process.platform === "win32" && !icon.isEmpty()) {
    icon = icon.resize({ width: 16, height: 16 });
  }
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        (app as any).isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Mira");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => showMainWindow());

  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
