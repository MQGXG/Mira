# Mira 开发上下文

## 当前阶段

原型阶段 — 核心功能已就绪，正在完善集成稳定性和开发者体验。

> **注意**：本文件基于实际代码（2026-08 审计）更新。AGENTS.md 为权威文档。

## 关键架构决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 桌面框架 | Electron 31 | 跨平台成熟，社区支持强 |
| Agent Core | TypeScript | 零 Python 依赖，单一技术栈 |
| 数据库 | SQLite (sql.js WASM) | 零配置，适合桌面应用 |
| 通信方式 | IPC (contextBridge) + Core HTTP sidecar (SSE) | 主进程与 Agent Core 分离 |
| 前端 UI | @assistant-ui/react | 现代化 AI 聊天组件 |
| 状态管理 | React hooks | 轻量级，桌面应用足够 |
| 向量记忆 | Transformers.js | 本地 ONNX 推理，零外部依赖 |
| LLM 架构 | 分层（schema→protocols→providers→route） | 可扩展，新协议/Provider 无侵入 |
| 插件框架 | Cordis（vendored 到 core）+ ctx.* 服务寻址 | "一切皆插件"：事件接缝/Provider 可替换/运行期自修改（详见 AGENTS.md「插件框架」） |

## 包结构

```
packages/
├── core/          # @mira/core — 核心逻辑（Agent/LLM/Tools/Memory）
├── electron/      # @mira/electron — Electron 主进程
├── ui/            # @mira/ui — React 前端组件
└── apps/desktop/  # @mira/desktop — Electron 应用壳
```

## Agent 系统

### 消息流

```
用户输入 → useMiraChat → AgentService.startStream (IPC) → sidecar-bridge → Core HTTP /api/agent/stream (SSE)
                                                              ↓
                                                     Agent.run() → LLM.stream() → Provider API
                                                              ↓
                                              AgentEvent (SSE 事件) → agent:event (IPC) → ChatWindow 消费
```

### 事件类型

| 事件 | 前端处理 | 说明 |
|------|----------|------|
| content | 追加文本 | 流式文本增量 |
| tool_start | 创建 ToolCall 卡片 | 工具调用开始，显示参数 |
| tool_result | 更新 ToolCall 状态 | 显示工具执行结果 |
| permission_request | 显示权限弹窗 | 需要用户审批 |
| thinking | 显示思考过程 | Agent 内部推理（DeepSeek reasoning_content） |
| finish | 完成 | 响应结束，携带真实 token usage |
| error | 显示错误 | 不可恢复的错误 |
| goal_status | 显示 Goal 状态 | 任务完成度验证 |
| context_rebuild | 显示重建通知 | 上下文窗口重建 |
| retry | 显示重试标记 | LLM 调用失败自动重试 |
| reasoning_start | 显示推理开始标记 | 推理内容流开始 |
| reasoning_delta | 追加推理文本 | 推理内容增量（DeepSeek thinking） |
| reasoning_end | 显示推理结束标记 | 推理内容流结束 |
| question | 显示提问弹窗 | Agent 向用户提问 |
| subagent_status | 显示子 Agent 状态 | 子 Agent 生命周期 |

## Token 统计

每条消息完成后从 LLM API 获取真实 token 使用量，存入 SQLite `sessions` 表（cost/tokens_* 列）：

| 字段 | 来源 | 说明 |
|------|------|------|
| tokens_input | LLM API response.usage | 输入 token 数 |
| tokens_output | LLM API response.usage | 输出 token 数 |
| tokens_reasoning | LLM API response.usage | 推理 token 数（DeepSeek） |
| tokens_cache_read | Anthropic/OpenAI usage | 缓存命中 token |
| tokens_cache_write | Anthropic usage | 缓存写入 token |
| cost | calculateCost(usage, pricing) | 会话累计成本（USD） |

## LLM Provider 支持（12 种）

| Provider | 状态 | 特殊说明 |
|----------|------|----------|
| OpenAI | 可用 | Chat Completions / Responses 双协议 |
| Anthropic Claude | 可用 | cache_control 注入 |
| DeepSeek | 可用 | 兼容 OpenAI 格式 + reasoning_content |
| Ollama (Local) | 可用 | 需要本地运行 Ollama |
| Groq | 可用 | 高速推理 |
| Fireworks / Together / Cerebras / Perplexity | 可用 | OpenAI 兼容 |
| Gemini | 可用 | 协议适配器 |
| Vertex | 可用 | Gemini 协议 |
| Custom | 可用 | 任意 OpenAI 兼容 API |

## 高级特性

### Goal Judge
独立验证 Agent，判断任务是否真正完成。防止 Agent 提前宣称"完成"。

### Max Mode
并行采样选优，每轮生成 N 个候选方案（clamp 2–8），由 judge 模型选出最优。

### Dynamic Workflow
代码级编排，将流程从 prompt 变为代码，确定性执行。

### Dream/Distill
- Dream：扫描会话轨迹，提取持久知识到项目记忆
- Distill：发现重复工作流，打包为可复用 skill/subagent

### Subagent
基于 Actor 模型的子 Agent 系统，支持 subagent（共享会话）和 peer（独立工作目录）两种模式。
SQLite 注册表持久化，TaskGate 任务完成验证，标准化返回协议，ReAct 循环，粘滞检测。

### MCP
Model Context Protocol（@modelcontextprotocol/sdk），local（stdio）/ remote（HTTP）服务器，运行时注册工具。

### LSP
Language Server Protocol，代码智能：定义跳转、引用查找、悬停、文件符号大纲、实现查找。声明式服务器定义（server-defs）+ 依赖自动安装（dependency）+ $/progress 索引进度等待（indexing）+ 编辑前后诊断对比自检（diagnostic-check）。

### Graph Engineering
图编排引擎（Planner/Runtime/Recovery 三层分离），支持 coding-task 模板、checkpoint 恢复、并行组、契约校验。

### Dynamic Memory
记忆图谱系统：节点/边/社区 + 衰减遗忘 + 激活传播 + 中文分词 + Transformers.js 向量嵌入。

### Voice
语音模块：能量 VAD + 打断管理 + Whisper STT（本地 ONNX）+ Kokoro TTS，支持实时语音对话。

### Widget
LLM 生成的 HTML 在沙箱 iframe 中渲染，注入本地 chart.js，支持查看/复制/下载代码。

### Live2D 桌宠
独立透明置顶窗口，支持 Live2D 角色显示、直接对话、嘴型同步、实时语音。

## 日志系统

- Electron 日志: `%APPDATA%/Mira/logs/mira-YYYY-MM-DD.log`
- Core 工具调用日志: `%APPDATA%/Mira/logs/agent-YYYY-MM-DD.log`
- 控制台输出 + 文件同时写入

## 常见问题

### API Key 未配置

在设置页面添加 Provider 并配置 API Key。目前支持：
- OpenAI: sk-xxx
- Claude: sk-ant-xxx
- DeepSeek: sk-xxx
- 自定义: 任意 API Key

### Playwright 未安装

如果需要使用 `web_browse` 工具，请运行：
```bash
npx playwright install chromium
```

## 下一步优化方向

1. 会话标题自动生成（已完成，根据首条消息内容生成）
2. 模型列表自动获取（拉取供应商可用模型）
3. Exa/Parallel 搜索 API 的配置 UI
4. `memory.searchByProject` / `memory.getGraphData` 已桥接进 preload（已完成）
5. 清理 preload 死 API（`python:*`、`agent.chat` / `runAgentStream`）
6. 清理未接线模块（provider-chain / fork-cache / system-context / tool-scope / run-coordinator）
7. 悬浮球 `sendMessage` 接入真实 Agent（当前仅回显）
