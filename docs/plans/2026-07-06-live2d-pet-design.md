# Live2D 桌宠设计文档

## 概述

在 Mira 桌面应用中增加一个独立的 Live2D 桌宠功能。桌宠是一个始终置顶的透明窗口，显示 Live2D 角色，支持直接对话（漫画风格气泡），可自由拖拽和调整大小。

## 架构

```
Settings (GeneralSettings.tsx)
  └─ IPC: live2d:toggle { enabled }
      └─ Main Process: PetWindowManager
           ├─ create()  → BrowserWindow (singleton)
           ├─ destroy() → 关闭窗口
           └─ drag-move / resize / position (保存/恢复)
               └─ Pet Window (separate renderer)
                    ├─ Live2D Canvas (pixi.js + easy-live2d)
                    ├─ Speech Bubble (漫画风格)
                    └─ Chat Input
                        └─ IPC: live2d:chat
                            └─ Main Process → Sidecar API
                                └─ IPC: live2d:chat-response (流式)
```

## 窗口配置

| 属性 | 值 | 说明 |
|------|-----|------|
| `width` | 280 | 默认宽度 |
| `height` | 380 | 默认高度 |
| `minWidth` | 200 | 最小宽度 |
| `minHeight` | 300 | 最小高度 |
| `transparent` | `true` | 背景完全透明 |
| `frame` | `false` | 无边框 |
| `alwaysOnTop` | `true` | 置顶 |
| `skipTaskbar` | `true` | 不在任务栏显示 |
| `resizable` | `true` | 可自由调整大小 |
| `hasShadow` | `false` | 无阴影 |

## 默认行为

- **桌宠默认关闭** — `localStorage("settings")` 中 `live2dPet` 默认 `false`
- **单例模式** — `PetWindowManager` 确保同一时间只有一个宠物窗口实例。再次打开时 focus 已有窗口
- **关闭行为** — 由设置项 `closePetWithApp` 控制（默认 `false`，即关主窗口时桌宠继续运行）

## 拖拽机制

- 宠物身体区域：`-webkit-app-region: drag`
- 输入框/按钮/气泡：`-webkit-app-region: no-drag`
- Electron 原生拖拽，无需自定义 IPC

## 对话界面

- **漫画风格气泡**：手绘风格边框 + 尖角指向角色 + 弹性动画
- **用户消息**：灰色气泡，右侧显示
- **角色回复**：白色气泡，带尖角指向 Live2D 角色
- **流式输出**：逐字显示 Agent 回复，同时触发 Live2D 嘴部动画

## 构建配置

`electron.vite.config.ts` renderer section 添加第二个入口：

```typescript
renderer: {
  build: {
    rollupOptions: {
      input: {
        index: path.join(__dirname, "apps/desktop/index.html"),
        pet: path.join(__dirname, "apps/desktop/pet.html"),
      }
    }
  }
}
```

宠物窗口使用与主窗口相同的 preload 脚本。

## IPC 通道

| 通道 | 方向 | 说明 |
|------|------|------|
| `live2d:toggle` | 渲染→主进程 | 启用/关闭宠物窗口 |
| `live2d:chat` | 宠物→主进程 | 发送消息给 Agent |
| `live2d:chat-response` | 主进程→宠物 | Agent 回复（流式） |
| `live2d:save-bounds` | 宠物→主进程 | 保存窗口位置/尺寸 |

## 持久化

- 开关状态：`localStorage("settings")` → `live2dPet: boolean`
- 关闭行为：`localStorage("settings")` → `closePetWithApp: boolean`
- 窗口位置/尺寸：`localStorage("pet-bounds")` → `{ x, y, width, height }`

## 文件清单

### 新增文件
| 文件 | 说明 |
|------|------|
| `apps/desktop/pet.html` | 宠物窗口 HTML 入口 |
| `apps/desktop/src/pet-main.tsx` | 宠物 React 入口 |
| `apps/desktop/src/pet/PetApp.tsx` | 宠物主组件 |
| `apps/desktop/src/pet/SpeechBubble.tsx` | 漫画风格对话气泡 |
| `apps/desktop/src/pet/ChatInput.tsx` | 输入框组件 |
| `packages/electron/src/live2d-pet/pet-manager.ts` | 宠物窗口管理器 |

### 修改文件
| 文件 | 修改内容 |
|------|----------|
| `electron.vite.config.ts` | renderer 添加入口 `pet` |
| `packages/electron/src/main/index.ts` | 初始化 PetWindowManager |
| `packages/electron/src/ipc/live2d-ipc.ts` | 宠物 IPC 处理器 |
| `packages/electron/src/ipc/handlers.ts` | 注册 live2d-ipc |
| `packages/electron/src/ipc/index.ts` | 导出 live2d-ipc |
| `packages/ui/src/sidebar/SettingsDialog/GeneralSettings.tsx` | 添加 Live2D 开关 |

## 实施顺序

1. Electron 主进程：PetWindowManager + IPC
2. 构建配置：pet.html Vite 入口
3. 宠物窗口 UI：Live2D 渲染 + 对话组件
4. 设置页开关

## 实现注意事项

### Pixi.js + easy-live2d 集成

宠物渲染使用 **Pixi.js 8** + **easy-live2d 0.4.4**，通过 `Application.init()` 创建 Pixi 实例，`Live2DSprite` 作为 stage 子节点。关键点：

- `Config.MotionGroupIdle = "Idle"` 在创建 sprite 前设置
- `sprite.width` 和 `sprite.height` 必须**同时设置**（`applyRequestedSize()` 对宽高独立处理）
- `preference: "webgl"` 强制使用 WebGL 渲染器（easy-live2d 不支持 WebGPU）
- `Ticker.shared` 传递给 sprite 构造函数，Pixi 自动管理渲染循环
- 模型缩放：`sprite.width = canvasWidth * 0.85; sprite.height = canvasHeight * 0.85`
- Cubism Core 5 兼容补丁：`renderOrders` → `drawOrders` 属性代理

### 硬件要求

- **必须硬件 GPU 加速**：Cubism Core 6 的复杂渲染管线（遮挡蒙版、多纹理 FBO、高精度 shader）在软件渲染器 `WebKit WebGL` 下不能正常产出像素
- `packages/electron/src/main/index.ts` 中添加了 GPU 强制参数（`ignore-gpu-blocklist`、`use-gl=angle`、`use-angle=d3d11`）
- 如果 `renderer` 显示为 `WebKit WebGL`，模型将不可见

### 已知问题：虚拟显卡驱动阻塞

向日葵（OrayIddDriver）和 GameViewer 等远程控制软件的**虚拟显卡驱动**会导致 Electron/Chromium 误判为无 GPU 环境，回退到软件渲染。

**症状**：宠物窗口控制台 `renderer: WebKit WebGL vendor: WebKit`，模型部件可见（129/134 drawables）且每帧 136 个 draw call 但无画面输出。

**解决方法**：设备管理器 → 显示适配器 → 卸载 OrayIddDriver Device 和 GameViewer Virtual Display Adapter → 重启
