# Live2D 桌宠 — 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
>
> **状态：** ✅ 已实施完成，详见 [设计文档](2026-07-06-live2d-pet-design.md)

**Goal:** 在 Mira 中实现独立的 Live2D 桌宠窗口，可置顶显示、自由拖拽缩放、直接对话

**Architecture:** 新增 Electron BrowserWindow（transparent/frame:false/alwaysOnTop），通过 Vite 多入口构建宠物页面，使用现有 agent.startStream + agent.onEvent IPC 进行对话，设置页开关控制启停

**Tech Stack:** Electron BrowserWindow, React 18, Pixi.js + easy-live2d, Tailwind CSS, Vite multi-entry

---

### Task 1: 构建配置 — Vite 多入口 + pet.html

**Files:**
- Modify: `electron.vite.config.ts`
- Create: `apps/desktop/pet.html`

**Step 1: 创建 pet.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mira Live2D Pet</title>
</head>
<body>
  <div id="pet-root"></div>
  <script type="module" src="./src/pet-main.tsx"></script>
</body>
</html>
```

**Step 2: 修改 electron.vite.config.ts**

在 renderer 的 build.rollupOptions.input 中添加 `pet` 入口：

```typescript
renderer: {
  root: ".",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "apps/desktop/pet.html"),
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@mira/core": resolve(__dirname, "packages/core/src"),
      "@mira/ui": resolve(__dirname, "packages/ui/src"),
      "@mira/electron": resolve(__dirname, "packages/electron/src"),
    },
  },
},
```

**Step 3: 验证构建**

Run: `pnpm build` (or just check vite config syntax)
Expected: no errors, pet.html is recognized as a valid entry

---

### Task 2: 主进程 — 宠物窗口管理器

**Files:**
- Create: `packages/electron/src/live2d-pet/pet-manager.ts`
- Modify: `packages/electron/src/managers/window-manager.ts` (导出 findVitePort)
- Modify: `packages/electron/src/main/index.ts` (导入并初始化)

**Step 1: 导出 findVitePort**

在 `packages/electron/src/managers/window-manager.ts` 的 `findVitePort` 函数前加 `export`：

```typescript
export async function findVitePort(): Promise<number> {
```

**Step 2: 创建 pet-manager.ts**

```typescript
import { BrowserWindow, app } from "electron"
import { join } from "path"
import { findVitePort } from "../managers/window-manager"

const isDev = !app.isPackaged

let petWindow: BrowserWindow | null = null

function getBoundsKey(): string {
  return "pet-bounds"
}

function loadBounds(): { x?: number; y?: number; width: number; height: number } {
  try {
    const raw = localStorage.getItem(getBoundsKey())
    if (raw) return JSON.parse(raw)
  } catch {}
  return { width: 280, height: 380 }
}

export function saveBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  localStorage.setItem(getBoundsKey(), JSON.stringify(bounds))
}

export async function createPetWindow(): Promise<BrowserWindow | null> {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show()
    petWindow.focus()
    return petWindow
  }

  const bounds = loadBounds()

  petWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 200,
    minHeight: 300,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  petWindow.on("close", (event) => {
    // 只隐藏不销毁，除非 app 退出
    if (!(app as any).isQuitting) {
      event.preventDefault()
      petWindow?.hide()
    }
  })

  petWindow.on("resize", () => {
    if (petWindow && !petWindow.isDestroyed()) {
      const [w, h] = petWindow.getSize()
      const [x, y] = petWindow.getPosition()
      saveBounds({ x, y, width: w, height: h })
    }
  })

  petWindow.on("move", () => {
    if (petWindow && !petWindow.isDestroyed()) {
      const [x, y] = petWindow.getPosition()
      const [w, h] = petWindow.getSize()
      saveBounds({ x, y, width: w, height: h })
    }
  })

  if (isDev) {
    const port = await findVitePort()
    await petWindow.loadURL(`http://localhost:${port}/pet.html`)
  } else {
    await petWindow.loadFile(join(__dirname, "../dist/pet.html"))
  }

  // 开发模式打开 DevTools
  if (isDev) {
    petWindow.webContents.openDevTools({ mode: "detach" })
  }

  return petWindow
}

export function destroyPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    if ((app as any).isQuitting) {
      petWindow.destroy()
    } else {
      petWindow.close()
    }
  }
  petWindow = null
}

export function hidePetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.hide()
  }
}

export function showPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show()
    petWindow.focus()
  }
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow
}
```

**Step 3: 在 main/index.ts 中初始化**

在 `packages/electron/src/main/index.ts` 中：

- 添加导入 `import { createPetWindow } from "../live2d-pet/pet-manager"`
- 在 `app.whenReady()` 之后（或 createWindow 附近）初始化
- 关联 app quit 事件：`app.on("before-quit", ...)` 时销毁宠物窗口

修改位置：在 `createWindow()` 调用之后。

---

### Task 3: IPC 处理器 — live2d-ipc.ts

**Files:**
- Create: `packages/electron/src/ipc/live2d-ipc.ts`
- Modify: `packages/electron/src/ipc/handlers.ts` (注册 live2d-ipc)

**Step 1: 创建 live2d-ipc.ts**

```typescript
import { ipcMain } from "electron"
import { createPetWindow, destroyPetWindow, hidePetWindow, showPetWindow, getPetWindow, saveBounds } from "../live2d-pet/pet-manager"

export function registerLive2dIPC(): void {
  ipcMain.handle("live2d:toggle", async (_, enabled: boolean) => {
    if (enabled) {
      await createPetWindow()
    } else {
      hidePetWindow()
    }
  })

  ipcMain.handle("live2d:save-bounds", async (_, bounds: { x: number; y: number; width: number; height: number }) => {
    saveBounds(bounds)
  })
}
```

**Step 2: 在 handlers.ts 中注册**

修改 `packages/electron/src/ipc/handlers.ts`：

- 添加导入 `import { registerLive2dIPC } from "./live2d-ipc"`
- 在 `registerIPCHandlers()` 函数中添加 `registerLive2dIPC()`

---

### Task 4: Preload — 添加 live2d API

**Files:**
- Modify: `packages/electron/src/preload/index.ts`

在 `electronAPI` 对象中添加 `live2d` 命名空间：

```typescript
live2d: {
  toggle: (enabled: boolean) => ipcRenderer.invoke("live2d:toggle", enabled),
  saveBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("live2d:save-bounds", bounds),
},
```

放在 `memory` 命名空间之后、`contextBridge.exposeInMainWorld` 之前。

---

### Task 5: 宠物窗口 — React 入口

**Files:**
- Create: `apps/desktop/src/pet-main.tsx`

```tsx
import React from "react"
import ReactDOM from "react-dom/client"
import { PetApp } from "./pet/PetApp"

// 简单重置样式
const style = document.createElement("style")
style.textContent = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #pet-root { width: 100%; height: 100%; overflow: hidden; }
  body { background: transparent; }
`
document.head.appendChild(style)

ReactDOM.createRoot(document.getElementById("pet-root")!).render(
  <React.StrictMode>
    <PetApp />
  </React.StrictMode>
)
```

---

### Task 6: 宠物窗口 — PetApp 主组件

**Files:**
- Create: `apps/desktop/src/pet/PetApp.tsx`
- Create: `apps/desktop/src/pet/SpeechBubble.tsx`
- Create: `apps/desktop/src/pet/ChatInput.tsx`

**PetApp.tsx** — 主组件，管理 Live2D 渲染、对话状态、窗口拖拽：

核心功能：
1. 加载 Live2DCubismCore（动态创建 script 标签）
2. 应用 Cubism Core 5 兼容补丁（renderOrders → drawOrders）
3. 创建 Pixi.js Application（transparent, autoDensity: true）
4. 创建 Live2DSprite
5. 渲染到透明 canvas 上
6. 底部显示 ChatInput + SpeechBubble
7. 整个窗口可拖拽（CSS `-webkit-app-region: drag`），输入框和气泡区域排除（`-webkit-app-region: no-drag`）
8. 对话使用 `window.electronAPI.agent.startStream` + `agent.onEvent`

**布局结构：**
```
┌──────────────────────────────────┐
│  · · · · · · · · · · · · · · · │ ← drag 区域
│    ┌──────────┐                 │ 
│    │ Live2D   │  SpeechBubble   │
│    │ 模型     │  (对话气泡)      │
│    └──────────┘                 │
│  · · · · · · · · · · · · · · · │
│  ┌─────────────────────┐        │ ← no-drag
│  │ 输入消息...    Send  │        │
│  └─────────────────────┘        │
└──────────────────────────────────┘
```

**对话流程：**
1. 用户输入消息 → 显示在右侧灰色气泡
2. 调用 `electronAPI.agent.startStream(sessionId, msg, config)`
3. 获取 channel，监听 `electronAPI.agent.onEvent(channel, callback)`
4. 收到 type:"delta" 事件 → 逐字追加到角色气泡
5. 收到 type:"finish" 事件 → 结束响应

**Session 管理：**
- 首次对话时创建 pet project + session
- 使用 `electronAPI.ts.createProject("Live2D Pet", "")` 
- 再使用 `electronAPI.ts.createSession(projectId, "Pet Chat")`
- 缓存 sessionId 防止重复创建

---

### Task 7: Settings — 添加 Live2D 开关

**Files:**
- Modify: `packages/ui/src/sidebar/SettingsDialog/GeneralSettings.tsx`

在通用设置中添加 Live2D 桌宠区域：

```
┌─ Live2D 桌宠 ──────────────────────┐
│  [⚙] 启用桌宠                   开关│
│  [⚙] 关闭主窗口时关闭桌宠       开关│
└─────────────────────────────────────┘
```

- 存入 `localStorage("settings")` 的 `live2dPet` 和 `closePetWithApp` 键
- 开关变化时调用 `window.electronAPI.live2d.toggle(checked)`
- 应用启动时读取 `live2dPet`，若为 true 则调用 `live2d.toggle(true)`

---

### Task 8: 应用启动恢复

**Files:**
- Modify: `packages/electron/src/main/index.ts`

在 `createWindow()` 之后，从配置中读取 `live2dPet` 状态（通过 localStorage 或 config.json），如果启用了则自动创建宠物窗口。

或者由渲染进程在加载完成后，从 localStorage 读取 `live2dPet` 并调用 `electronAPI.live2d.toggle(true)`。

推荐方案：渲染进程的 `App.tsx` 或 `SettingsDialog` 初始化时检查 `localStorage("settings")`，若 `live2dPet === true` 则调用 `window.electronAPI.live2d.toggle(true)`。

---

### Task 9: 验证

1. `pnpm dev` 启动应用
2. 打开设置 → 通用 → 启用 Live2D 桌宠
3. 确认出现透明置顶宠物窗口，Live2D 模型渲染正常
4. 拖拽窗口确认可自由移动
5. 调整窗口大小确认正常
6. 输入对话内容确认消息发送和接收
7. 关闭主窗口确认桌宠不受影响（默认设置）
8. 重新打开主窗口确认桌宠仍在
9. 设置中关闭桌宠确认窗口消失
10. 重启应用确认桌宠状态保持（默认关闭）
