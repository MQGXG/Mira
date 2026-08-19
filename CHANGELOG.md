# 更新日志

## [Unreleased]

### 新增
- Live2D 桌宠功能：独立透明置顶窗口，支持 Live2D 角色显示和直接对话
  - Pixi.js 8 + easy-live2d 0.4.4 渲染
  - Electron BrowserWindow (transparent/frame:false/alwaysOnTop)
  - 漫画风格对话气泡 + 流式 Agent 回复
  - 设置页开关控制 + 窗口位置记忆
  - GPU 强制参数（`ignore-gpu-blocklist` + `use-angle=d3d11`）

## [1.0.0] - 2026-06-15

### 新增
- TypeScript Agent Core 完整实现（ReAct 循环、工具系统、权限系统）
- 前端 UI 全面升级（毛玻璃设计、响应式布局、暗色/亮色主题）
- 多 Provider 支持（OpenAI / Anthropic Claude / DeepSeek / Ollama / 自定义 API）
- 4 种 Agent 模式（助手 / 专家 / 执行 / 安全）
- 工具面板（不经过 LLM 直接执行工具）
- SSE 流式聊天响应
- 文件拖拽上传分析
- 会话分叉（Fork）功能
- API Key 加密存储（Electron safeStorage）
- 系统托盘 + 全局快捷键（Ctrl+Shift+A）
- 便携 Python 环境自动管理
- SQLite + ChromaDB 会话持久化

### 优化
- 响应式布局：窗口 < 1024px 自动折叠侧边栏
- 消息操作：复制、编辑、重发、分叉
- 项目悬浮卡片：显示完整项目名、路径、快捷操作
- 设置页搜索过滤
- 会话列表按更新时间排序
- 空状态引导优化（含快捷键提示）
- 主题切换平滑过渡
- 网格布局响应式适配（Provider 配置、颜色选择等）

### 修复
- 编辑/重发消息时闭包捕获旧 input 值的问题

### 清理
- 移除未使用的 `electron/python-manager.ts`
- 删除构建产物和冗余数据目录
- 移除遗留的 Python 后端 (`agent-backend/`)、`docker-compose.yml`、`.dockerignore`
- 清理 `start.ps1`、`start.sh`、`setup.ps1` 中的 Python 引用
- 更新 `CONTEXT.md` 移除 Python 相关内容
- 新增 ESLint 配置 (`.eslintrc.json`) + `npm run lint` 脚本

## [0.9.0] - 2026-06-11

### 新增
- Python FastAPI 后端完整实现
- 项目管理（创建、切换、编辑、删除）
- 会话管理（创建、删除、历史加载）
- 基础聊天界面
- Electron 窗口管理 + 自定义标题栏
- 项目初始化结构和构建配置

## [0.1.0] - 2026-06-01

### 新增
- 项目初始化
- Electron + React + TypeScript 脚手架搭建
- Tailwind CSS 集成
- 基础构建流程配置
