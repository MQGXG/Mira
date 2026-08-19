# Mira

全能 AI 助手桌面应用 — 集聊天、搜索、编程、数据分析于一体。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面壳 | Electron 31 + electron-vite |
| 前端 | React 18 + TypeScript 5 + Tailwind CSS + @assistant-ui/react |
| Agent Core | TypeScript（纯 TS 实现，零 Python 依赖） |
| 数据库 | SQLite (sql.js WASM，防抖持久化) |
| 向量记忆 | Transformers.js 本地 ONNX 推理 |
| 代码智能 | LSP (Language Server Protocol) |
| 协议扩展 | MCP (Model Context Protocol) |
| HTML 转换 | Turndown（HTML → Markdown 专业转换） |
| 插件框架 | Cordis（vendored，ctx.* 服务寻址 + 类型化事件 + 可逆 effect） |
| 构建 | electron-builder |

## 快速开始

```powershell
# 1. 安装依赖（需要 pnpm）
pnpm install

# 2. 开发模式启动
pnpm dev

# 3. 打包给其他电脑
pnpm package:win
# 生成 release\Mira-1.0.0-portable.exe
# 复制到其他电脑直接双击运行！
```

## 项目结构

```
mira/
├── packages/
│   ├── core/                        # @mira/core — Agent Core 核心逻辑
│   │   └── src/
│   │       ├── agent/               # Agent 核心循环（agent/turn-runner/turn-classifier/state-machine）
│   │       ├── llm/                 # LLM 分层架构（协议/Provider/路由）
│   │       ├── tools/               # 48 个默认注册工具
│   │       ├── memory/              # 记忆系统（FTS5 + 动态记忆图谱 + 向量嵌入）
│   │       ├── graph/               # Graph Engineering 图编排引擎
│   │       ├── orchestrate/         # 子 Agent / Goal Judge / Dream / ACP
│   │       ├── skill/               # Skill 系统
│   │       ├── framework/           # Cordis 适配层（Context + 类型化事件 + 插件桥）
│   │       ├── services/            # ctx.* 服务实现（llm/tools/permissions/capability…）
│   │       ├── selfmod/             # 运行期自修改（Agent 定义/激活/卸载插件）
│   │       ├── vendor/              # vendored Cordis 框架内核
│   │       ├── permission/          # 声明式权限
│   │       └── ...                  # 配置/数据库/会话管理等
│   │
│   ├── electron/                    # @mira/electron — Electron 主进程
│   │   └── src/
│   │       ├── main/                # 应用入口
│   │       ├── preload/             # 安全桥接 (contextBridge)
│   │       ├── ipc/                 # IPC 通信（15 个模块）
│   │       ├── managers/            # 窗口/托盘/悬浮球管理
│   │       └── utils/               # 日志/环境变量
│   │
│   └── ui/                          # @mira/ui — React 前端组件
│       └── src/
│           ├── chat/                # 聊天组件（流式渲染/工具视图/权限弹窗）
│           ├── sidebar/             # 侧边栏（项目/会话/设置）
│           ├── memory/              # 知识图谱 3D 可视化
│           ├── services/            # IPC 服务层（含语音服务）
│           └── ui/                  # 通用 UI
│
├── apps/
│   └── desktop/                     # @mira/desktop — Electron 应用壳
│       ├── src/App.tsx              # 应用根组件
│       ├── src/pet/                 # Live2D 桌宠
│       ├── index.html
│       └── widget-test.html         # Widget 测试 HTML
│
├── data/                            # 运行时数据
├── pet.html                        # 桌宠窗口 HTML
├── docs/                            # 文档
└── package.json                     # 根 package.json（pnpm monorepo）
```

## 桌面特性

- 无边框窗口 + 自定义标题栏
- 系统托盘 + 全局快捷键 `Ctrl+Shift+A`
- 本地文件拖拽分析
- 多模型切换（OpenAI / Anthropic / DeepSeek / Ollama / Groq / Gemini 等 12 Provider）
- 5 种 Agent 模式（助手 / 专家 / 执行 / 安全 / 规划）+ 自定义 Agent
- 48 个内置工具（文件操作 / 代码执行 / 网页搜索 / Git / 数据分析 / 记忆 / 文档生成 / 工作流等）
- 声明式权限系统（通配符匹配 + 模式叠加 + 运行时审批 + 硬拒绝列表）
- 记忆系统（FTS5 全文搜索 + 动态记忆图谱 + 向量嵌入 + 中文分词）
- Goal Judge（任务完成度验证）
- Max Mode（并行采样选优）
- Dynamic Workflow（代码级编排）
- Subagent 管理（最大并行 5 个，支持 Actor 模型/任务门控/ReAct 循环/粘滞检测）
- Graph Engineering（图编排引擎：coding-task 模板 / checkpoint 恢复 / 并行组 / 契约校验）
- MCP 协议支持（扩展工具能力）
- LSP 代码智能（定义跳转 / 引用查找 / 悬停 / 符号大纲 / 实现查找，依赖自动安装 + 索引进度等待 + 编辑后诊断自检）
- Skill 系统（Slash 命令 + 动态加载）
- API Key 加密存储（Electron safeStorage）
- 浏览器自动化（Playwright 截图/点击/输入，支持 SPA 页面）
- 文件快照回退（每次编辑前自动快照，支持一键恢复）
- Widget 渲染（LLM 生成 HTML 沙箱 iframe + 本地 chart.js）
- 插件框架（"一切皆插件"：Cordis 内核 + ctx.* 服务寻址 + 事件接缝 + Capability Seam 换 Provider 工具即时跟随）
- 运行期自修改（mira_plugin_* 工具让 Agent 自己定义/激活/卸载插件，VM 沙箱 + 审批门 + Web Worker client 隔离）
- Live2D 桌宠（透明置顶窗口，直接对话 + 嘴型同步 + 语音）
- 语音对话（能量 VAD + Whisper STT + Kokoro TTS）
- Token 成本追踪（模型定价表 + 会话级成本）
- 便携打包，目标电脑无需安装任何运行时

## 开发指南

```bash
# 安装依赖
pnpm install

# 启动开发模式
pnpm dev

# 测试
pnpm test

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint

# 打包
pnpm package:win    # Windows
pnpm package:mac    # macOS
pnpm package:linux  # Linux
```

## 环境要求

- Node.js 18+（corepack 随 Node 提供）
- pnpm 8+（根 `packageManager` 锁定 pnpm@11.9.0，推荐通过 `corepack pnpm` 使用）
- Windows / macOS / Linux
- **无需 Python**（Agent Core 完全由 TypeScript 实现）
