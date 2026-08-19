import { ipcMain, dialog, Notification, safeStorage, app } from "electron";
import { promises as fs } from "fs";
import * as path from "path";
import { getMainWindow, minimizeWindow, toggleMaximizeWindow, hideWindow } from "../managers/window-manager";
import { registerAgentIPCHandlers } from "./index";
import { getFloatingBallManager } from "../managers/floating-ball-manager";
import { notifyRendererBooted } from "./renderer-boot";
import { createAttachmentSelection, assertAttachmentBudget, readAttachment, releaseAttachmentSelection } from "../main/attachment-picker";

export function registerIPCHandlers(): void {
  registerAgentIPCHandlers();

  // 窗口控制
  ipcMain.on("window:minimize", () => minimizeWindow());
  ipcMain.on("window:maximize", () => toggleMaximizeWindow());
  ipcMain.on("window:close", () => hideWindow());

  // 渲染层首帧就绪上报（取消 boot 超时恢复提示）
  ipcMain.on("mira:renderer-boot", () => {
    notifyRendererBooted();
  });

  // 文件对话框
  ipcMain.handle("dialog:openDirectory", async () => {
    const win = getMainWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    return result.filePaths;
  });

  ipcMain.handle("dialog:openFile", async (event) => {
    const win = getMainWindow();
    if (!win) return { token: "", files: [] };
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "所有文件", extensions: ["*"] },
        { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "tiff", "tif", "heic", "heif"] },
        { name: "文档", extensions: ["docx", "xls", "xlsx", "xlsm", "ods", "pptx", "pdf", "txt", "md", "markdown", "csv", "json", "yaml", "yml", "xml", "log", "ini", "conf"] },
        { name: "代码文件", extensions: ["py", "js", "ts", "tsx", "jsx", "java", "c", "cpp", "h", "hpp", "rs", "go", "rb", "sh", "bash", "sql", "html", "htm", "css", "scss", "sass", "php"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { token: "", files: [] };

    const files = await Promise.all(
      result.filePaths.map(async (filePath) => ({
        path: filePath,
        name: path.basename(filePath),
        size: (await fs.stat(filePath)).size,
      })),
    );
    try {
      assertAttachmentBudget(files);
    } catch (e) {
      return { token: "", files: [], error: e instanceof Error ? e.message : String(e) };
    }
    const token = createAttachmentSelection(event.sender.id, result.filePaths);
    return { token, files };
  });

  // 读取已选择附件（token 授权 + 预算校验）
  ipcMain.handle("dialog:readFile", async (event, token: string, filePath: string) => {
    return readAttachment(event.sender.id, token, filePath);
  });

  // 释放附件授权
  ipcMain.handle("dialog:releaseFiles", (event, token: string) => {
    releaseAttachmentSelection(event.sender.id, token);
  });

  ipcMain.handle("dialog:saveFile", async (_, defaultName: string) => {
    const win = getMainWindow();
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, { defaultPath: defaultName });
    return result.filePath;
  });

  // 写入文件（供渲染层下载 widget/导出内容）
  ipcMain.handle("ts:writeFile", async (_, filePath: string, content: string) => {
    if (!filePath || typeof content !== "string") return false;
    await fs.writeFile(filePath, content, "utf-8");
    return true;
  });

  // 读取会话附件（历史恢复：相对路径 → base64 data URL）
  ipcMain.handle("ts:readAttachment", async (_, relPath: string) => {
    if (!relPath || typeof relPath !== "string") return "";
    // relPath 形如 "attachments/{sessionId}/{file}"，已含 attachments 前缀
    const base = path.join(app.getPath("userData"));
    const abs = path.resolve(base, relPath);
    if (!abs.startsWith(path.join(app.getPath("userData"), "attachments") + path.sep)) return "";
    try {
      const data = await fs.readFile(abs);
      const ext = path.extname(abs).slice(1).toLowerCase();
      const mime = ext === "pdf" ? "application/pdf"
        : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "gif" ? "image/gif"
        : ext === "webp" ? "image/webp"
        : "image/png";
      return `data:${mime};base64,${data.toString("base64")}`;
    } catch { return ""; }
  });

  // 默认工作目录（Documents/Mira，回退 home/Mira）
  ipcMain.handle("ts:getDefaultWorkspace", async () => {
    let base = "";
    try { base = app.getPath("documents"); } catch { /* ignore */ }
    if (!base) {
      try { base = app.getPath("home"); } catch { /* ignore */ }
    }
    if (!base) return "";
    const dir = path.join(base, "Mira");
    try { await fs.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
  });

  // 系统通知
  ipcMain.handle("notify", (_, title: string, body: string) => {
    new Notification({ title, body }).show();
  });

  // API Key 加密存储
  ipcMain.handle("safeStorage:encrypt", (_, text: string) => {
    if (!safeStorage.isEncryptionAvailable()) return "";
    if (!text) return "";
    const encrypted = safeStorage.encryptString(text);
    return encrypted.toString("base64");
  });

  ipcMain.handle("safeStorage:decrypt", (_, encrypted: string) => {
    if (!safeStorage.isEncryptionAvailable()) return "";
    if (!encrypted) return "";
    const buffer = Buffer.from(encrypted, "base64");
    return safeStorage.decryptString(buffer);
  });

  ipcMain.handle("safeStorage:isAvailable", () => safeStorage.isEncryptionAvailable());

  // 桌面悬浮球
  ipcMain.handle("floatingBall:toggle", async (_, enabled: boolean) => {
    const manager = getFloatingBallManager();
    if (enabled) {
      await manager.create();
    } else {
      manager.destroy();
    }
    return { success: true };
  });

  ipcMain.on("floatingBall:wake", () => {
    const manager = getFloatingBallManager();
    manager.wake('ipc');
  });

  ipcMain.on("floatingBall:hide", () => {
    const manager = getFloatingBallManager();
    manager.hide('ipc');
  });

  ipcMain.handle("floatingBall:updateConfig", (_, config: Record<string, unknown>) => {
    const manager = getFloatingBallManager();
    if (typeof config.autoHideTimeout === 'number') {
      manager.updateConfig({ autoHideTimeout: config.autoHideTimeout });
    }
    if (typeof config.shortcut === 'string') {
      manager.registerShortcut(config.shortcut);
    }
    return { success: true };
  });
}
