# Live2D 头像集成指南

## 模型制作流程

### 1. 准备原图
- 分辨率：至少 2048x2048
- 格式：PNG（透明背景）
- 将角色拆分为独立图层（眼睛、嘴巴、头发、身体等）

### 2. 使用 Live2D Cubism Editor
1. 下载 [Live2D Cubism Editor](https://www.live2d.com/en/download/cubism-sdk/download-editor/)（免费版可用）
2. 导入原图
3. 拆分网格（ArtMesh）
4. 设置变形器（Deformer）
5. 绑定动作（Motion）
6. 导出为 `.moc3` + `.model3.json` + 贴图

### 3. 文件结构
```
public/models/mira/
├── mira.model3.json      # 模型配置（必需）
├── mira.moc3             # 编译后的模型（必需）
├── mira.physics3.json    # 物理模拟（可选）
├── textures/
│   └── texture_00.png    # 贴图文件
└── motions/
    ├── idle.motion3.json
    ├── think.motion3.json
    ├── talk.motion3.json
    └── error.motion3.json
```

### 4. model3.json 示例
```json
{
  "Version": 3,
  "FileReferences": {
    "Moc": "mira.moc3",
    "Textures": ["textures/texture_00.png"],
    "Motions": {
      "Idle": [{"File": "motions/idle.motion3.json"}],
      "Think": [{"File": "motions/think.motion3.json"}],
      "Talk": [{"File": "motions/talk.motion3.json"}],
      "Error": [{"File": "motions/error.motion3.json"}]
    }
  }
}
```

## 快速开始（使用示例模型）

如果没有 Cubism Editor，可以使用免费示例模型测试：

```bash
# 下载示例模型到 public/models/
curl -o public/models/mira/mira.model3.json https://cdn.jsdelivr.net/gh/nicecao/live2d-models@master/haru/haru_greeter_t03.model3.json
```

## 代码使用

```tsx
import { Live2DAvatar } from "../components/assistant-ui/live2d-avatar"

// 基础用法
<Live2DAvatar size={200} />

// 带状态切换
<Live2DAvatar state={isRunning ? "speaking" : "idle"} size={200} />

// 自定义模型路径
<Live2DAvatar modelPath="/models/custom/model.model3.json" size={200} />
```

## 状态对应动作

| 状态 | 动作组 | 用途 |
|------|--------|------|
| idle | Idle | 空闲状态，眼睛跟随鼠标 |
| thinking | Think | 思考中，点头/摇头 |
| speaking | Talk | 说话时嘴部动画 |
| error | Error | 出错提示 |

## 桌宠 (Desktop Pet)

Mira 支持独立的 Live2D 桌宠窗口，基于 Pixi.js + easy-live2d 实现。

### 硬件要求

**必须硬件 GPU 加速。** Cubism Core 6 在软件渲染器（`WebKit WebGL`）下不能正常渲染。

已知阻塞 GPU 检测的软件驱动：
- 向日葵 (OrayIddDriver Device)
- GameViewer Virtual Display Adapter
- 远程桌面 (RDP) 虚拟显示适配器

**解决**：设备管理器 → 显示适配器 → 卸载上述虚拟设备 → 重启应用。

### 技术栈

- **Pixi.js 8** + **easy-live2d 0.4.4**
- `preference: "webgl"` 强制 WebGL（easy-live2d 不支持 WebGPU）
- `Ticker.shared` 自动管理渲染循环
- 模型路径：`/models/hiyori/Hiyori.model3.json`

### 文件结构

```
packages/electron/src/
├── live2d-pet/pet-manager.ts    # 透明置顶窗口管理
├── ipc/live2d-ipc.ts            # 桌宠开关 IPC
└── main/index.ts                # GPU 强制参数 + 退出清理

apps/desktop/src/pet/
├── PetApp.tsx                   # 主组件：Live2D + 对话
├── SpeechBubble.tsx             # 漫画风格气泡
└── ChatInput.tsx                # 输入框
```
