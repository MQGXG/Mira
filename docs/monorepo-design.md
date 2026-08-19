# Mira Monorepo 架构设计

## 概述

Mira 采用 pnpm monorepo 架构，将代码组织为 4 个包，实现清晰的关注点分离。

## 目录结构

```
mira/
├── packages/
│   ├── core/                    # @mira/core — 核心逻辑
│   │   ├── src/
│   │   │   ├── agent.ts         # Agent 核心循环
│   │   │   ├── agent/           # Agent 子模块（状态机/回合/Max Mode）
│   │   │   ├── llm/             # LLM 分层架构
│   │   │   ├── tools/           # 32 个工具
│   │   │   ├── memory/          # 四层记忆系统
│   │   │   ├── permission.ts    # 权限系统
│   │   │   ├── skill/           # 技能系统
│   │   │   ├── workflow/        # Dynamic Workflow
│   │   │   ├── mcp/             # MCP 协议
│   │   │   ├── lsp/             # LSP 代码智能
│   │   │   └── index.ts         # 导出
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── electron/                # @mira/electron — Electron 主进程
│   │   ├── src/
│   │   │   ├── main/            # 主进程入口
│   │   │   ├── preload/         # 预加载脚本 (contextBridge)
│   │   │   ├── ipc/             # IPC 通信（14 个模块）
│   │   │   ├── managers/        # 窗口/托盘管理
│   │   │   └── utils/           # 日志/环境变量
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── ui/                      # @mira/ui — React 前端组件
│   │   ├── src/
│   │   │   ├── chat/            # 聊天组件
│   │   │   ├── sidebar/         # 侧边栏组件
│   │   │   ├── layout/          # 布局组件
│   │   │   ├── ui/              # 通用 UI 组件
│   │   │   ├── hooks/           # React Hooks
│   │   │   ├── contexts/        # React Contexts
│   │   │   └── index.ts         # 导出
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── apps/
│       └── desktop/             # @mira/desktop — Electron 应用壳
│           ├── src/
│           │   ├── App.tsx       # 根组件
│           │   ├── main.tsx      # React 入口
│           │   ├── main.ts       # Electron 入口
│           │   └── styles/       # 全局样式
│           ├── index.html
│           ├── electron.vite.config.ts
│           └── electron-builder.yml
│
├── docs/                        # 文档
├── data/                        # 运行时数据 (SQLite)
├── memory/                      # 会话记忆 JSON
├── vector-memory/               # 向量记忆存储
├── tasks/                       # 任务进度
├── checkpoints/                 # 检查点快照
├── resources/                   # 打包资源（图标等）
├── package.json                 # 根 package.json
├── pnpm-workspace.yaml          # pnpm workspace 配置
└── tsconfig.json                # 根 TypeScript 配置
```

## 包描述

### @mira/core

核心逻辑包，**无外部依赖**（除 zod、effect、@modelcontextprotocol/sdk）。

包含：
- Agent 核心循环（状态机、回合处理、上下文管理）
- LLM 分层架构（schema → protocols → providers → route）
- 32 个工具实现
- 四层记忆系统（checkpoint/builtin/fts/file/vector）
- 声明式权限系统
- Agent 模式配置（可扩展）
- Dynamic Workflow 编排
- MCP 协议支持
- LSP 代码智能
- Subagent 管理
- Goal Judge / Max Mode
- Dream/Distill 记忆进化

### @mira/electron

Electron 主进程包，依赖 `@mira/core`。

包含：
- 应用入口（main/index.ts）
- 预加载脚本（preload/index.ts）
- IPC 通信层（14 个模块）
- 窗口/托盘管理
- 日志/环境变量工具

### @mira/ui

React 前端组件包，依赖 `@mira/core`。

包含：
- 聊天组件（ChatWindow、ToolCallView、PermissionDialog 等）
- 侧边栏组件（Sidebar、ProjectBar、SettingsDialog 等）
- 通用 UI 组件（基于 Radix UI）
- React Hooks
- React Contexts

依赖：
- @assistant-ui/react — AI 聊天 UI 框架
- Radix UI — 基础组件
- Tailwind CSS — 样式
- lucide-react — 图标

### @mira/desktop

Electron 应用壳，依赖以上三个包。

包含：
- 应用根组件（App.tsx）
- React 入口（main.tsx）
- Electron 入口（main.ts）
- Vite 构建配置
- electron-builder 打包配置

## 依赖关系

```
@mira/desktop
  ├── @mira/core
  ├── @mira/ui
  └── @mira/electron

@mira/electron
  └── @mira/core

@mira/ui
  └── @mira/core

@mira/core（独立）
  └── zod, effect, @modelcontextprotocol/sdk
```

## 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式（从根目录）
pnpm dev

# 构建所有包
pnpm build

# 类型检查
pnpm typecheck

# 测试
pnpm test

# 打包桌面应用
pnpm package:win    # Windows
pnpm package:mac    # macOS
pnpm package:linux  # Linux
```

## 添加新模块

### 添加新工具

1. 在 `packages/core/src/tools/` 创建 `.ts` 文件
2. 使用 `make()` + Zod Schema 定义
3. 在 `tools/index.ts` 导出
4. 在 `registry-init.ts` 注册

### 添加新 Provider

1. 在 `packages/core/src/llm/providers/` 创建实现
2. 如需新协议，在 `packages/core/src/llm/protocols/` 创建适配
3. 在 `route/route.ts` 注册路由

### 添加新模式

1. 在 `packages/core/src/agent-profile.ts` 的 `createDefaultRegistry()` 中注册
2. 或在 `~/.config/mira/agents/` 创建 JSON 配置文件

### 添加新 IPC 模块

1. 在 `packages/electron/src/ipc/` 创建模块
2. 在 `handlers.ts` 注册
3. 在 `preload/index.ts` 暴露 API

## 优势

1. **关注点分离** — 每个包职责清晰
2. **依赖管理** — 包间依赖关系明确
3. **独立构建** — 支持增量构建
4. **可复用性** — @mira/core 可独立使用
5. **开发体验** — pnpm workspace 高效管理
