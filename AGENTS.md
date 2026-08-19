# Mira 项目文档

## 项目概述

Mira 是一个全能 AI 助手桌面应用，基于 **Electron + TypeScript Agent Core** 架构打造，**零 Python 依赖**。

## 技术栈

| 层次 | 技术选型 |
|------|----------|
| 桌面框架 | Electron 31 (electron-vite) |
| 前端 | React 18 + TypeScript 5 + Tailwind CSS + @assistant-ui/react + @assistant-ui/react-streamdown |
| Agent Core | TypeScript（纯 TS 实现，无 Python） |
| LLM | OpenAI / Anthropic Claude / DeepSeek / Ollama / Groq / Gemini / 自定义 API（共 12 种 Provider） |
| 数据库 | SQLite (sql.js WASM，防抖持久化) |
| 向量记忆 | Transformers.js 本地 ONNX 推理（零外部依赖） |
| 代码智能 | LSP (Language Server Protocol) |
| 协议扩展 | MCP (Model Context Protocol) |
| HTML 转换 | Turndown（HTML → Markdown 专业转换） |
| 3D 图谱 | react-force-graph-3d + three.js |
| 动态头像 | untitled-pixi-live2d-engine + pixi.js v8 (Live2D Cubism SDK 5-r.4) |
| 文档生成 | docx / xlsx / pptx（Word / Excel / PowerPoint 原生生成） |
| 构建 | electron-builder（便携模式，目标电脑无需安装任何运行时） |

## 目录结构

```
mira/
├── packages/
│   ├── core/                        # @mira/core — Agent Core 核心逻辑
│   │   └── src/
│   │       ├── index.ts             # 统一导出（~240 行公共 API 面）
│   │       ├── types.ts             # AgentEvent 类型（15 种事件变体）
│   │       ├── compose-mode.ts      # 组合模式（phase 驱动的软件开发工作流）
│   │       ├── agent/               # Agent 核心子模块
│   │       │   ├── index.ts
│   │       │   ├── agent.ts         #   Agent 主编排（~502行，输入队列 + 内层 ReAct 循环）
│   │       │   ├── stages.ts        #   5 阶段拆分（prepare/restore/buildMessages/handleTurn/finalize + 辅助）
│   │       │   ├── agent-internals.ts#  AgentInternals 依赖契约（循环插件化替换边界）
│   │       │   ├── constants.ts     #   AgentConfig + DEFAULT_SYSTEM
│   │       │   ├── context.ts       #   系统提示构建 + SourceManager（7 种 Source）
│   │       │   ├── state-machine.ts #   生命周期状态机（显式 TRANSITIONS 表）
│   │       │   ├── turn-runner.ts   #   单回合引擎（ConcurrencyGate 并发 + 权限快速检查 + agent/request·tools/* 事件接缝）
│   │       │   ├── turn-classifier.ts# 回合分类（max-turns/failed/重复文本/tool-suggest）
│   │       │   ├── turn.ts          #   简化回合运行器（runLLMTurn，max 5 次重试）
│   │       │   ├── max-mode.ts      #   并行采样选优（runMaxMode + judge 模型）
│   │       │   ├── utils.ts         #   Doom Loop / N-gram 重复 / 溢出检测
│   │       │   ├── text-ngram.ts    #   文本 N-gram 流式重复检测
│   │       │   ├── input-queue.ts   #   PendingInputQueue（FIFO + steer 优先）
│   │       │   ├── stop-hooks.ts    #   停止钩子（autoDream + memoryPromote 内置钩子）
│   │       │   ├── run-coordinator.ts# Run 协调器（coalesced wakeup / interrupt）
│   │       │   ├── session-restore.ts# 会话恢复（与 agent.ts 私有实现平行）
│   │       │   ├── system-context.ts#   系统级上下文（增量 Source + 快照）
│   │       │   ├── fork-cache.ts    #   分支缓存（TTL LRU，未接入循环）
│   │       │   └── registry.ts      #   Agent 内部注册表（name → impl 映射）
│   │       ├── llm/                 # LLM 分层架构
│   │       │   ├── index.ts
│   │       │   ├── client.ts        #   LLM 客户端（createLLMClient + 统一事件归一化）
│   │       │   ├── builtin-providers.ts# 模型目录加载器（加载 model-catalog.json 为 TS 数据）
│   │       │   ├── provider-catalog.ts# Provider 目录（createRoute + getCatalogForUI）
│   │       │   ├── cache-policy.ts  #   缓存策略（Anthropic cache_control 注入）
│   │       │   ├── follow-up.ts     #   LLM 生成追问建议
│   │       │   ├── provider-policy.ts#  Provider 策略引擎（allow/deny 规则）
│   │       │   ├── provider-chain.ts#   Provider 链（优先级排序，未用于 Agent 循环）
│   │       │   ├── tool-runtime.ts  #   工具运行时（ToolDef → LLM schema）
│   │       │   ├── transform.ts     #   消息转换（多模态/推理内容适配）
│   │       │   ├── schema/          #   消息/事件/错误类型
│   │       │   │   ├── index.ts
│   │       │   │   ├── messages.ts  #     LLMMessage 类型（含 reasoning_content）
│   │       │   │   ├── events.ts    #     流式事件类型
│   │       │   │   ├── errors.ts    #     LLMError 类型
│   │       │   │   └── options.ts   #     请求选项
│   │       │   ├── protocols/       #   协议适配器
│   │       │   │   ├── index.ts
│   │       │   │   ├── openai-chat.ts         # OpenAI Chat Completions
│   │       │   │   ├── openai-responses.ts    # OpenAI Responses API
│   │       │   │   ├── openai-compatible-chat.ts # OpenAI 兼容协议
│   │       │   │   ├── anthropic-messages.ts  # Anthropic Messages API
│   │       │   │   └── gemini.ts              # Google Gemini
│   │       │   ├── providers/       #   Provider 类型别名（数据在 builtin-providers.ts）
│   │       │   │   └── index.ts
│   │       │   └── route/           #   路由客户端
│   │       │       ├── index.ts
│   │       │       ├── types.ts     #   路由类型（Auth/Endpoint/Framing/Protocol）
│   │       │       ├── route.ts     #   路由实例创建（raw fetch SSE）
│   │       │       └── client.ts    #   路由客户端实现（敏感字段脱敏）
│   │       ├── config/              # 配置模块
│   │       │   ├── index.ts         #   MiraConfig 加载（全局/项目/env 深合并 + {env}/{file} 替换）
│   │       │   ├── flags.ts         #   特性开关（12 个默认 flag，localStorage 持久化）
│   │       │   ├── modes.ts         #   Agent 模式定义（5 种内置）
│   │       │   ├── paths.ts         #   跨平台路径
│   │       │   ├── profile.ts       #   Agent 配置（AgentProfileRegistry，JSON 可序列化）
│   │       │   └── bundle.ts        #   Bundle/patch 配置组合（BundleRegistry + plugins.patch.json + dump-config）
│   │       ├── system/              # 系统级模块
│   │       │   ├── database.ts      #   SQLite (sql.js)，防抖持久化 + FTS5 + 迁移
│   │       │   ├── instruction.ts   #   指令上下文（AGENTS.md 收集）
│   │       │   ├── logger.ts        #   日志系统（内存环 + 每日文件）
│   │       │   ├── registry.ts      #   工具注册表（ToolRegistry）
│   │       │   ├── tool-materializer.ts# 物化 + JSON Schema 转换 + 模型过滤
│   │       │   ├── tool-scope.ts    #   作用域工具注册表（application/session/mode 等）
│   │       │   ├── mcp-plugin-registry.ts# MCP/Plugin 生命周期管理
│   │       │   ├── registry-init.ts #   注册表初始化（48 个默认工具）
│   │       │   ├── server-manager.ts#   服务器管理器（子进程 HTTP + SSE 桥接）
│   │       │   ├── permission/      #   权限子模块
│   │       │   │   ├── index.ts     #     PermissionSet（通配符匹配 + 硬拒绝列表）
│   │       │   │   ├── gate.ts      #     权限门控（三层 Gate + 资源提取）
│   │       │   │   ├── store.ts     #     权限规则存储（SQLite）
│   │       │   │   └── approval-store.ts # 审批存储（TTL 缓存 + 持久化）
│   │       │   └── server/          #   API 服务
│   │       │       ├── index.ts
│   │       │       ├── server.ts    #     HTTP 服务（REST + SSE 流式）
│   │       │       ├── api.ts       #     API 处理器
│   │       │       └── cli.ts       #     CLI 入口
│   │       ├── session/             # 会话管理
│   │       │   ├── manager.ts       #   项目/会话管理
│   │       │   ├── store.ts         #   会话持久化（事件为事实源 + 投影缓存）
│   │       │   ├── context.ts       #   上下文窗口管理（checkpoint/rebuild）
│   │       │   ├── compaction.ts    #   上下文压缩（工具配对平衡 + 收益校验）
│   │       │   ├── context-epoch.ts #   上下文纪元跟踪
│   │       │   ├── fork.ts          #   会话分支
│   │       │   ├── snapshot.ts      #   会话快照（磁盘持久化）
│   │       │   ├── context-source.ts#   系统上下文 Source 管理
│   │       │   ├── structured-summary.ts# 结构化摘要
│   │       │   ├── tool-pairing.ts  #   工具配对平衡（压缩切口校验）
│   │       │   ├── event-store.ts   #   事件存储（事件溯源：追加/读取/快照）
│   │       │   ├── event-types.ts   #   SessionEventMap 事件映射 + 判别联合（可合并扩展）
│   │       │   └── projector.ts     #   事件流投影为消息（快照 + 增量重建）
│   │       ├── memory/              # 记忆系统
│   │       │   ├── manager.ts       #   记忆管理器
│   │       │   ├── types.ts         #   记忆类型定义
│   │       │   ├── builtin-provider.ts    #   内置记忆提供者
│   │       │   ├── checkpoint-provider.ts #   检查点提供者
│   │       │   ├── file-memory-provider.ts #  文件记忆提供者
│   │       │   ├── fts-memory-provider.ts #  全文搜索记忆提供者（FTS5）
│   │       │   ├── vector-provider.ts     #   向量记忆提供者
│   │       │   ├── dynamic-memory.ts      #   动态记忆图谱管理器
│   │       │   ├── dynamic-memory-store.ts#   记忆图谱 SQLite 持久化（节点/边/社区/嵌入）
│   │       │   ├── memory-node.ts         #   记忆节点/边/图谱模型 + 衰减配置
│   │       │   ├── memory-activation.ts   #   激活传播算法
│   │       │   ├── memory-strength.ts     #   记忆强度计算
│   │       │   ├── decay-curve.ts         #   遗忘衰减曲线
│   │       │   ├── embedding.ts           #   向量嵌入（Transformers.js ONNX）
│   │       │   ├── embedding-cache.ts     #   嵌入缓存
│   │       │   ├── chinese-tokenizer.ts   #   中文分词
│   │       │   ├── chinese-synonyms.ts    #   中文同义词
│   │       │   ├── synonym-discovery.ts   #   同义词自动发现
│   │       │   ├── memory-extractor.ts    #   记忆提取引擎
│   │       │   └── recall-budget.ts       #   召回预算控制
│   │       ├── shared/              # 共享工具模块
│   │       │   ├── tool.ts          #   工具定义工厂（make/settle）
│   │       │   ├── tool-executor.ts #   工具执行器（批量并发执行）
│   │       │   ├── tool-effect.ts   #   Effect 风格工具定义（define/init）
│   │       │   ├── zod-converter.ts #   Zod → JSON Schema 转换
│   │       │   ├── message-utils.ts #   消息工具函数（修复/截断/重建）
│   │       │   ├── token-meter.ts   #   固定密度 token 估算器（结构感知）
│   │       │   ├── plugin-hooks.ts  #   插件钩子（emitWaterfall/triggerUntil）
│   │       │   ├── hooks-setup.ts   #   Hook 默认设置
│   │       │   ├── cost.ts          #   Token 成本追踪（模型定价表）
│   │       │   └── errors.ts        #   统一错误分类（MiraError）
│   │       ├── orchestrate/         # 编排模块
│   │       │   ├── goal-judge.ts    #   Goal 完成度验证
│   │       │   ├── goal-manager.ts  #   Goal 管理
│   │       │   ├── subagent.ts      #   子 Agent 管理（Actor 模型）
│   │       │   ├── actor-gate.ts    #   任务完成门控（TaskGate）
│   │       │   ├── actor-protocol.ts #   标准化返回协议
│   │       │   ├── delegate.ts      #   任务委派执行
│   │       │   ├── team-bus.ts      #   团队通信总线
│   │       │   ├── execution.ts     #   工具编排执行（并行/串行）
│   │       │   ├── dream.ts         #   Dream 记忆进化
│   │       │   ├── distill.ts       #   Distill 工作流提取
│   │       │   ├── dream-graph.ts   #   Dream 图谱构建
│   │       │   ├── dream-types.ts   #   Dream 类型定义
│   │       │   ├── failover.ts      #   LLM 故障转移（FallbackClient，Agent 循环实际使用）
│   │       │   └── acp/             #   Agent Communication Protocol
│   │       │       ├── index.ts
│   │       │       ├── types.ts     #     ACP 类型
│   │       │       ├── message.ts   #     消息工厂（20 个工厂函数）
│   │       │       └── work-state-machine.ts # 工作状态机
│   │       ├── graph/               # Graph Engineering 图编排引擎（Planner/Runtime/Recovery 三层分离）
│   │       │   ├── index.ts         #   统一导出（StateGraph/Planner/Recovery/模板）
│   │       │   ├── types.ts         #   核心类型（Node/Edge/State + Schema + 契约 + 并行组）
│   │       │   ├── state.ts         #   StateStore（Schema 校验 + replace/append/reducer 更新 + snapshot/mergePatch）
│   │       │   ├── runtime.ts       #   StateGraph 运行时（next_node 路由/条件边/失败回退/checkpoint/并行组/契约校验）
│   │       │   ├── planner.ts       #   Planner 层（输入状态 → 图定义，createPlanner/composePlanner）
│   │       │   ├── recovery.ts      #   Recovery 层（单节点重入上限 + 全局执行上限 + 失败升级决策）
│   │       │   ├── persist.ts       #   图运行持久化
│   │       │   ├── nodes/           #   节点实现
│   │       │   │   └── agent-runner.ts #     Agent 节点运行器
│   │       │   └── templates/       #   业务图模板
│   │       │       └── coding-task.ts #     coding-task 模板（iterations 迭代 + recovery）
│   │       ├── task/                # 任务管理
│   │       │   ├── tracker.ts       #   任务追踪
│   │       │   ├── planner.ts       #   任务规划
│   │       │   └── budget.ts        #   迭代预算控制
│   │       ├── background/          # 后台任务
│   │       │   ├── index.ts         #   后台任务队列（isSlowOperation 检测）
│   │       │   ├── cron.ts          #   定时调度（零依赖 cron 解析器）
│   │       │   ├── notifier.ts      #   后台任务完成通知
│   │       │   ├── recovery.ts      #   错误恢复（分类 + 退避策略）
│   │       │   └── worktree.ts      #   Git Worktree 管理
│   │       ├── skill/               # Skill 系统
│   │       │   ├── skill-loader.ts  #   动态加载（frontmatter 解析）
│   │       │   ├── skill-commands.ts#   Slash 命令匹配
│   │       │   └── skill-tools.ts   #   Skill 工具（skills_list / skill_view）
│   │       ├── tools/               # 工具层（48 个默认注册工具）
│   │       │   ├── index.ts         #   导出所有工具
│   │       │   ├── core/            #   文件/代码工具（read/write/edit/grep/glob/git/apply_patch/docx/xlsx/pptx/svg/webpage/mockup/todo/change-directory/get-current-time/session-cwd/search-history）
│   │       │   ├── execution/       #   执行工具（bash/run_code/image_generate）
│   │       │   ├── knowledge/       #   知识工具（web_search/web_browse/web_fetch/data_analysis/memory/memory-graph/chart + content-filter/ssrf-util）
│   │       │   ├── orchestrate/     #   编排工具（agent-tools/delegate-task/team-tool/task-tool/cron-tool/worktree-tool/workflow-tool）
│   │       │   ├── infra/           #   基础设施（lsp-tool）
│   │       │   ├── interaction/     #   交互工具（question）
│   │       │   └── shared/          #   工具共享（tool-loader/tool-meta/tool-output-store）
│   │       ├── lsp/                 # LSP 代码智能
│   │       │   ├── client.ts        #   LSP 客户端（JSON-RPC over stdio + Content-Length 帧解析 + 通知/请求分发）
│   │       │   ├── manager.ts       #   LSP 管理器（生命周期编排 + 高层查询 API）
│   │       │   ├── server-defs.ts   #   语言服务器定义（声明式，含版本锁定依赖）
│   │       │   ├── dependency.ts    #   依赖解析（系统 PATH → 本地缓存 → 自动安装）
│   │       │   ├── indexing.ts      #   索引进度追踪（$/progress）
│   │       │   ├── diagnostic-check.ts # 编辑前后诊断对比（编辑后自检）
│   │       │   └── code-context.ts  #   代码上下文提取
│   │       ├── mcp/                 # MCP 协议支持
│   │       │   └── index.ts         #   MCPManager + jsonSchemaToZod
│   │       ├── plugin/              # 插件系统
│   │       │   └── index.ts         #   PluginManager（动态 import 加载）
│   │       ├── workflow/            # Dynamic Workflow 编排
│   │       │   └── index.ts         #   WorkflowEngine（agent/bash/parallel/pipeline/transform）
│   │       ├── voice/               # 语音模块（renderer-safe 纯入口）
│   │       │   ├── index.ts         #   renderer-safe 导出（引擎/注册表/编排/工具，无 Node）
│   │       │   ├── types.ts         #   引擎接口（STT/TTS/VAD 可插拔）+ VoiceSessionConfig
│   │       │   ├── engines/         #   内置引擎实现（whisper / webspeech-stt / kokoro / webspeech-tts / energy-vad）
│   │       │   ├── registry.ts      #   纯注册表 VoiceRegistry（工厂/引擎缓存/默认选中项）
│   │       │   ├── catalog-loader.ts#   Node 加载器（内置 voice-catalog.json + 用户 voice.json，initVoiceCatalog）
│   │       │   ├── voice-session.ts #   统一编排（VAD 检话/采集/转写/打断/turn 世代）
│   │       │   ├── emitter.ts       #   LightEmitter（纯 TS 事件，替代 Node events）
│   │       │   ├── audio-utils.ts / transformers-loader.ts # 音频播放/录制 + transformers.js 加载
│   │       │   ├── vad.ts           #   语音活动检测（能量分析，Node 侧，经 core/index 导出）
│   │       │   ├── interruption.ts / announcement-window.ts # 语音打断管理（Node 侧，经 core/index 导出）
│   │       ├── vendor/               # vendored Cordis 框架（源码引入，"一切皆插件"内核）
│   │       │   ├── cordis/           #   Context（服务注册表）/Events/Fiber/Registry/Service/Reflect
│   │       │   ├── cosmokit/         #   工具函数库（cosmokit）
│   │       │   └── schemastery/      #   Schema 校验（schemastery）
│   │       ├── framework/            # Cordis 适配层（服务注册表 + 类型化事件 + 插件桥）
│   │       │   ├── context.ts        #   Mira Context 扩展（ctx.tools/llm/permissions/fs/… 单一寻址空间）
│   │       │   ├── events.ts         #   类型化事件（declare module 合并：agent/pre-step/request、tools/pre-execute…）
│   │       │   ├── services.ts       #   createMiraContext 引导（注册全部服务）
│   │       │   ├── plugins.ts        #   MiraPluginManager（Cordis Registry 封装 + 目录扫描）
│   │       │   └── plugin-adapter.ts #   旧 Mira 插件 → Cordis 插件桥接（可逆 effect 回滚）
│   │       ├── services/             # Cordis 服务实现（ctx.*）
│   │       │   ├── index.ts          #   统一导出
│   │       │   ├── llm.ts            #   ctx.llm（客户端工厂 + 模型目录）
│   │       │   ├── tools.ts          #   ctx.tools（注册/物化/ScopedToolRegistry 作用域/执行）
│   │       │   ├── permissions.ts    #   ctx.permissions（allow/deny/ask 三层 Gate）
│   │       │   ├── sessions.ts       #   ctx.sessions（会话 CRUD）
│   │       │   ├── memory.ts / dynamic-memory.ts # ctx.memory（6 层 Provider）/ ctx.dynamicMemory（图谱）
│   │       │   ├── mcp.ts            #   ctx.mcp（MCP 连接管理）
│   │       │   ├── capability.ts     #   ctx.fs/subprocess/shell（Capability Seams，setProvider 换产品）
│   │       │   └── agent-loop.ts     #   ctx.agentLoop（AgentLoopImpl + setLoop 可替换循环）
│   │       ├── selfmod/              # 运行期自修改（"一切皆插件"终局：Agent 定义/激活/卸载插件）
│   │       │   ├── index.ts          #   setupSelfModification 装配 + 导出
│   │       │   ├── sandbox.ts        #   VM 沙箱（预检 + 超时 + Node API 重定向 + 受限 ctx）
│   │       │   ├── registry.ts       #   动态插件注册表（Plugin → 不可变 Package 版本）
│   │       │   ├── runner.ts         #   生命周期（define/run/stop/undefine + 审批门 + 持久化）
│   │       │   ├── storage.ts        #   SQLite 持久化（重启恢复）
│   │       │   └── tools.ts          #   mira_plugin_define/run/stop/undefine/list/inspect
│   │       ├── types/ambient.d.ts   # 全局类型声明
│   │       └── __tests__/           # 测试（Vitest 4，66+ 文件 630+ 用例，core 内）
│   │
│   ├── electron/                    # @mira/electron — Electron 主进程
│   │   └── src/
│   │       ├── index.ts             # 统一导出
│   │       ├── ambient.d.ts
│   │       ├── main/index.ts        # 应用入口（GPU 开关 + sidecar 启动 + 全局快捷键）
│   │       ├── preload/index.ts     # 预加载脚本 (contextBridge)
│   │       ├── ipc/                 # IPC 通信层（15 个模块，~98 个 handler）
│   │       │   ├── index.ts         #   统一注册
│   │       │   ├── handlers.ts      #   窗口/对话框/安全存储 handler
│   │       │   ├── compose-ipc.ts   #   组合模式
│   │       │   ├── config-ipc.ts    #   配置读写
│   │       │   ├── dream-ipc.ts     #   Dream/Distill
│   │       │   ├── goal-ipc.ts      #   Goal 管理
│   │       │   ├── graph-ipc.ts     #   Graph 图编排执行
│   │       │   ├── live2d-ipc.ts    #   Live2D 桌宠开关
│   │       │   ├── memory-ipc.ts    #   记忆操作（代理到 sidecar HTTP）
│   │       │   ├── question-ipc.ts  #   用户交互
│   │       │   ├── session-ipc.ts   #   会话/项目 CRUD
│   │       │   ├── sidecar-bridge.ts#   Sidecar 进程通信（SSE 桥接）
│   │       │   ├── skill-ipc.ts     #   Skill 加载
│   │       │   ├── subagent-ipc.ts  #   子 Agent 状态
│   │       │   └── task-ipc.ts      #   任务管理
│   │       ├── managers/            # 窗口/托盘管理
│   │       │   ├── window-manager.ts      #   主窗口（1200×800 无边框）
│   │       │   ├── tray-manager.ts        #   系统托盘
│   │       │   └── floating-ball-manager.ts #  悬浮球窗口（懒加载）
│   │       ├── live2d-pet/pet-manager.ts # Live2D 桌宠窗口（透明置顶）
│   │       └── utils/               # 日志/环境变量
│   │           ├── logger.ts        #   日志初始化 + console 重定向
│   │           └── shell-env.ts     #   环境变量注入
│   │
│   └── ui/                          # @mira/ui — React 前端组件
│       └── src/
│           ├── index.ts             # 统一导出
│           ├── vite-env.d.ts
│           ├── chat/                # 聊天组件
│           │   ├── ChatWindow.tsx   #   主聊天界面（Primitives 拼装）
│           │   ├── MiraRuntimeProvider.tsx # 运行时状态（ExternalStoreRuntime）
│           │   ├── ModelSelector.tsx #  模型/模式选择
│           │   ├── PermissionDialog.tsx # 权限审批弹窗
│           │   ├── ProgressBar.tsx  #   进度条
│           │   ├── QuestionDialog.tsx #  用户交互弹窗
│           │   ├── ThinkingBlock.tsx #  思考过程展示
│           │   ├── MiraLogo.tsx     #   Mira 标识
│           │   ├── VoiceInput.tsx   #   语音输入
│           │   ├── VoiceChatButton.tsx # 实时语音对话按钮
│           │   ├── ToolCallView.tsx #   工具调用展示（工具分组/回退按钮）
│           │   ├── ToolPalette.tsx  #   工具面板
│           │   ├── MessageBubble.tsx#   消息气泡
│           │   ├── GraphPanel.tsx   #   coding-task 图运行面板
│           │   ├── tool-router.ts   #   工具路由
│           │   ├── mira-runtime.ts  #   运行时类型
│           │   ├── types.ts         #   类型定义
│           │   ├── types-message.ts #   MiraPart 消息类型（含 widget）
│           │   ├── slash-commands.ts#   Slash 命令
│           │   ├── follow-up-suggestions.ts # 追问建议
│           │   ├── tool-views/      #   工具结果视图
│           │   │   ├── ContextToolGroup.tsx # 上下文工具组折叠面板
│           │   │   ├── tool-fold.ts
│           │   │   ├── ToolDiffSummary.tsx
│           │   │   ├── ToolDiffView.tsx
│           │   │   ├── ToolGenericView.tsx
│           │   │   ├── ToolIcon.tsx
│           │   │   ├── ToolReadView.tsx
│           │   │   ├── ToolSearchView.tsx
│           │   │   └── ToolShellView.tsx
│           │   └── __tests__/       #   follow-up-suggestions / zod-schema 测试
│           ├── components/          # 组件
│           │   ├── ErrorBoundary.tsx
│           │   ├── assistant-ui/    #   assistant-ui 扩展组件
│           │   │   ├── markdown-text.tsx
│           │   │   ├── reasoning.tsx
│           │   │   ├── tool-fallback.tsx
│           │   │   ├── tool-group.tsx
│           │   │   ├── diff-viewer.tsx
│           │   │   ├── message-timing.tsx
│           │   │   ├── context-display.tsx
│           │   │   ├── tooltip-icon-button.tsx
│           │   │   ├── animated-avatar.tsx   # CSS 动画头像
│           │   │   ├── animated-avatar.css   # 头像动画样式
│           │   │   ├── widget-renderer.tsx   # Widget 渲染器（沙箱 iframe）
│           │   │   ├── widget-utils.ts       # Widget 提取/本地资源注入
│           │   │   └── widget-test-main.tsx  # Widget 测试入口
│           │   └── ui/              #   shadcn 基础 UI 组件（10 个）
│           │       ├── button.tsx
│           │       ├── collapsible.tsx
│           │       ├── dialog.tsx
│           │       ├── dropdown-menu.tsx
│           │       ├── input.tsx
│           │       ├── Modal.tsx
│           │       ├── select.tsx
│           │       ├── switch.tsx
│           │       ├── tabs.tsx
│           │       └── tooltip.tsx
│           ├── memory/              #   知识图谱
│           │   ├── MemoryGraph.tsx  #     3D 力导向图谱组件
│           │   ├── GraphPanel.tsx   #     图谱全屏面板
│           │   └── graph-data.ts    #     实体/关系提取引擎
│           ├── sidebar/             # 侧边栏
│           │   ├── Sidebar.tsx
│           │   ├── ProjectBar.tsx
│           │   ├── SettingsDialog/      #   设置弹窗
│           │   │   ├── index.tsx        #     主入口（5 个标签页 + 搜索）
│           │   │   ├── GeneralSettings.tsx
│           │   │   ├── ShortcutsSettings.tsx
│           │   │   ├── AboutSettings.tsx
│           │   │   └── useSettingsSearch.ts
│           │   ├── ConfigSourceIndicator.tsx
│           │   ├── ModelManager.tsx
│           │   ├── provider-data.ts
│           │   ├── ProviderConfigPanel.tsx
│           │   ├── ThemeSelector.tsx
│           │   ├── NewProjectDialog.tsx
│           │   ├── EditProjectDialog.tsx
│           │   └── types.ts
│           ├── layout/TitleBar.tsx  # 自定义标题栏（未在 App.tsx 中使用）
│           ├── hooks/               # React Hooks
│           │   ├── session-runtime-store.ts # 多会话并发全局 Store（useSyncExternalStore）
│           │   ├── stream-events.ts #   流事件处理器
│           │   ├── useAgent.ts
│           │   ├── useMiraChat.ts   #   核心聊天状态机
│           │   ├── useProjects.ts
│           │   └── useSessions.ts
│           ├── contexts/ThemeContext.tsx # React Contexts
│           ├── theme/data-colors.ts #   项目颜色管理
│           ├── lib/                 # 工具函数
│           │   ├── attachment-adapter.ts
│           │   └── utils.ts
│           ├── services/            # 服务层（IPC 封装）
│           │   ├── agent.service.ts / config.service.ts / dialog.service.ts
│           │   ├── graph.service.ts / memory.service.ts
│           │   ├── project.service.ts / session.service.ts / index.ts
│           │   └── voice/           #   语音服务（引擎获取层 + 薄封装 core）
│           │       ├── engine-registry.ts # 目录驱动引擎获取（IPC catalog → core 工厂）
│           │       ├── realtime-voice.ts  # 实时语音对话薄封装（VoiceSessionManager）
│           │       ├── stt.ts / tts.ts / transformers-loader.ts # 旧 API 薄代理（向后兼容）
│           │       ├── types.ts / lip-sync.ts / motion-manager.ts / motion-plugins.ts
│           │       └── __tests__/         # tts 薄代理 / lip-sync / motion-manager 测试
│           └── types/               # 类型声明
│               ├── ambient.d.ts / electron.d.ts
│
├── apps/
│   └── desktop/                     # @mira/desktop — Electron 应用壳
│       ├── src/
│       │   ├── App.tsx              # 应用根组件（顶栏 + Sidebar + ChatWindow + 弹窗）
│       │   ├── components/StartupOverlay.tsx # 启动加载遮罩（数据就绪后淡出）
│       │   ├── main.tsx             # React 入口
│       │   ├── pet-main.tsx         # Live2D 桌宠 React 入口
│       │   ├── pet/                 # 桌宠组件
│       │   │   ├── PetApp.tsx       #   Live2D 渲染 + 聊天 + 流式 Agent 回复
│       │   │   ├── ChatInput.tsx    #   桌宠聊天输入
│       │   │   └── SpeechBubble.tsx #   对话气泡
│       │   └── styles/globals.css   # 全局样式
│       ├── index.html               # HTML 模板（CSP 配置）
│       ├── widget-test.html         # Widget 测试 HTML
│       └── electron.vite.config.ts  # Vite 构建配置（备选）
│
├── public/                          # Vite 静态资源（根目录）
│   ├── Core/                        #   Live2D Cubism Core
│   │   └── live2dcubismcore.min.js  #     Cubism 运行时
│   └── models/                      #   Live2D 模型文件
│       └── hiyori/                  #     示例模型
│           ├── Hiyori.model3.json   #       模型配置
│           ├── Hiyori.moc3          #       编译后模型
│           └── textures/            #       贴图文件
├── data/                            # 运行时数据
├── memory/                          # 会话记忆 JSON
├── vector-memory/                   # 向量记忆存储
├── tasks/                           # 任务进度
├── checkpoints/                     # 检查点快照
├── docs/                            # 文档
├── resources/                       # 打包资源（图标等）
├── logs/                            # 运行日志
├── pet.html                        # 桌宠窗口 HTML
├── scripts/                         # 安装脚本
├── package.json                     # 根 package.json
├── pnpm-workspace.yaml              # pnpm workspace 配置
├── electron.vite.config.ts          # 根 Vite 配置（main/preload/renderer 三入口）
├── electron-builder.yml             # 根打包配置
├── tailwind.config.js               # Tailwind 主题
├── postcss.config.js                # PostCSS 配置
├── tsconfig.json                    # 根 TypeScript 配置
├── vitest.config.ts                 # 测试配置
├── components.json                  # shadcn 组件配置
├── AGENTS.md                        # 本文件
├── CONTEXT.md                       # 开发上下文
├── CONTRIBUTING.md                  # 贡献指南
└── README.md                        # 项目说明
```

## 包依赖关系

```
@mira/desktop (应用壳)
  ├── @mira/core
  ├── @mira/ui
  └── @mira/electron

@mira/electron (Electron 主进程)
  └── @mira/core

@mira/ui (前端组件)
  └── @mira/core

@mira/core (核心逻辑)
  └── (独立)
```

## Agent 模式

| 模式 | 描述 | 迭代上限 | 权限规则 / 工具限制 |
|------|------|----------|----------|
| 助手 (assistant) | 日常问答、写作、分析 | 10 | bash/code_exec 需审批；白名单工具（含 apply_patch 等 32 个） |
| 专家 (expert) | 深度研究、数据分析 | 25 | bash 需审批；其余全开 |
| 执行 (action) | 自动化任务、批量处理 | 50 | 全部工具 + 无审批 |
| 安全 (safe) | 只读探索 | 5 | 禁止 write/edit/bash/code_exec；只读白名单 |
| 规划 (plan) | 代码分析、方案设计 | 15 | 禁止 write/edit/bash/code_exec/cron/worktree/image_gen；只读 + LSP |

支持通过 `~/.config/mira/agents/` 和 `{project}/.mira/agents/` 目录加载自定义 Agent JSON 配置（`AgentProfileRegistry`，优先级：内置默认 < 全局 < 项目）。

## 工具清单（48 个默认注册）

| 分类 | 工具 | 说明 |
|------|------|------|
| **core** | read_file | 读取文件/目录（魔数检测 + 编码检测 + 图片支持） |
| | write_file | 创建/覆盖文件（BOM 保留 + stale 检测 + 写入锁） |
| | edit_file | 编辑文件指定部分（9 种匹配策略 + LSP 回退） |
| | apply_patch | 多文件批量编辑（4 层模糊匹配 + ChangeContext 锚点） |
| | list_files | 列出目录内容（含大小） |
| | grep | 正则内容搜索（ripgrep） |
| | glob | 文件名模式匹配 |
| | code_search | 代码语义搜索 |
| | git_status / git_diff / git_log / git_commit | Git 状态/差异/历史/提交 |
| | todo_write | Todo 任务管理（创建/更新/列表/完成/删除） |
| | search_history | 跨会话历史记录搜索 |
| | get_current_time / change_directory | 获取当前时间 / 会话级目录切换 |
| | invalid | 非法工具兜底（工具不存在时返回友好错误） |
| **document** | create_docx | Word .docx 文档生成 |
| | create_xlsx | Excel .xlsx 多工作表生成 |
| | create_pptx | PowerPoint .pptx 生成 |
| | create_webpage | 交互式 HTML 页面生成 |
| | create_mockup | SVG UI 线框/原型生成 |
| | create_svg | 抽象 SVG 插图/封面生成 |
| **knowledge** | web_search | 网络搜索（Exa/Parallel MCP → DuckDuckGo → SEArxNG 降级 + TTL 缓存） |
| | web_browse | 网页浏览（Playwright，navigate/click/type/scroll/capture） |
| | web_fetch | URL 内容获取（Turndown + SSRF 防护 + TTL 缓存） |
| | data_analysis | 数据分析（CSV 统计/相关/趋势/分布 + 图表） |
| | create_chart | SVG 图表生成 |
| | memory_search | 记忆全文搜索（FTS5） |
| | memory_recall | 记忆召回 |
| **execution** | bash | Shell 命令执行（PowerShell/CMD/Unix sh + bash-security 预检） |
| | run_code | 代码执行（Python/Node 沙箱） |
| | image_generate | AI 图片生成（DALL-E-3） |
| **orchestrate** | delegate_task | 任务委派给子 Agent |
| | team_tool | 团队协作工具（消息/收件箱/协议） |
| | plan_task | 多步骤任务规划 |
| | cronjob | 定时任务调度 |
| | worktree | Git Worktree 隔离任务目录 |
| | workflow_run | Dynamic Workflow 执行 |
| | spawn_agent / wait_agents / list_subagents | 子 Agent 生命周期管理 |
| **infra** | lsp_definition / lsp_references / lsp_hover / lsp_symbols / lsp_implementations | 代码定义跳转/引用查找/悬停/文件符号大纲/实现查找 |
| **skill** | skills_list / skill_view | 列出/查看 Skill |
| **interaction** | question | 向用户提问 |

> **补充**：另有 5 个记忆图谱工具已实现并导出（`memory_activate`、`memory_graph_add_node`、`memory_graph_add_edge`、`memory_graph_query`、`memory_graph_decay`），但**未加入默认注册表**（`registry-init.ts` 未引用）。此外 MCP / Plugin / 自定义工具在运行时动态注册，工具名加 `[MCP: ]` / `[Plugin: ]` 前缀。
>
> **运行期自修改工具**（`selfmod/tools.ts`）：`mira_plugin_define` / `mira_plugin_run` / `mira_plugin_stop` / `mira_plugin_undefine` / `mira_plugin_list` / `mira_plugin_inspect` — Agent 在运行期定义、持久化、激活、卸载自己的插件，经 VM 沙箱 + 审批门执行。
>
> **历史命名注意**：文档/权限规则中出现的 `code_exec`、`cron_tool`、`worktree_tool`、`image_gen`、`task_planner` 等为权限 action 或旧名，实际注册的工具名为 `run_code`、`cronjob`、`worktree`、`image_generate`、`plan_task`。

## LLM Provider 支持（12 种）

| Provider | 类型 | 默认 Base URL |
|----------|------|--------------|
| OpenAI | 原生 | `api.openai.com/v1` |
| Anthropic | 原生 | `api.anthropic.com` |
| DeepSeek | 兼容 | `api.deepseek.com` |
| Ollama | 兼容 | `localhost:11434/v1` |
| Groq | 兼容 | `api.groq.com/openai/v1` |
| Fireworks | 兼容 | `api.fireworks.ai/inference/v1` |
| Together | 兼容 | `api.together.xyz/v1` |
| Cerebras | 兼容 | `api.cerebras.ai/v1` |
| Perplexity | 兼容 | `api.perplexity.ai` |
| Gemini | 协议适配 | Gemini API |
| Vertex | 协议适配 | Vertex AI API |
| Custom | 兼容 | 用户自定义 URL |

Provider 数据定义在 `resources/models/model-catalog.json`（内置目录，含 models + 上下文窗口 + 成本 + 能力），由 `builtin-providers.ts` 加载为 TS 数据，`ProviderCatalog` 负责路由到对应协议。

> **模型目录可插拔（一切皆插件）**：能力数据统一收敛到 `ProviderCatalog`（Core 单一数据源）。三层合并：
> 1. **内置** `resources/models/model-catalog.json`（打包经 `electron-builder.yml` 的 `resources/models → models` extraResources 分发）
> 2. **全局用户** `~/.config/mira/models.json`（`config/models-config.ts` 加载）：`providers`（完整 ProviderDef，新增 provider 或整体覆盖内置）+ `overrides`（对已注册 provider 增量覆盖，如为模型追加 `capabilities: ["vision"]`）
> 3. **插件** `PluginContext.registerProvider(def)`（`plugin/index.ts`）
>
> 生产链路统一走 `ProviderCatalog.initProviderCatalog()`（内置 + 用户配置，幂等）；UI 经 `config:getProviderCatalog` IPC 拉取目录，视觉能力判断（`ui/src/sidebar/provider-model.ts`）直接查目录 `capabilities`，不再维护本地白名单（`VISION_MODELS` 已移除；`isVisionModel` = 目录能力优先，用户声明的 type 兜底）。

## 高级特性

### 插件框架（Cordis，"一切皆插件"）
Mira 已落地完整插件框架内核（对齐 deepseek-harness 的 vendored Cordis）：

| 支柱 | 说明 | 位置 |
|------|------|------|
| **框架内核** | Context（服务仓库）+ inject 依赖声明 + Fiber 生命周期 + 可逆 effect | `vendor/cordis/` |
| **类型化事件** | `declare module` 合并事件表 + 5 种分发（emit/parallel/serial/bail/waterfall） | `framework/events.ts` |
| **统一服务寻址** | `ctx.tools/llm/permissions/sessions/memory/dynamicMemory/mcp/catalog/config/agentLoop/fs/subprocess/shell` | `framework/context.ts` + `services/` |
| **Capability Seams** | `ctx.fs/subprocess/shell.setProvider()` 换 Provider 换产品（同步 capabilityRegistry，工具即时跟随） | `services/capability.ts` |
| **循环插件化** | `AgentLoopImpl` + `setLoop()` 可替换；`agent/pre-step/request`、`tools/pre-execute/post-execute` 事件接缝已接通 | `services/agent-loop.ts`、`agent/stages.ts` |
| **配置组合** | Bundle 叠加 + `{project}/.mira/plugins.patch.json` 覆盖 + `dumpConfig()` | `config/bundle.ts` |
| **运行期自修改** | Agent 用 `mira_plugin_*` 定义/持久化/激活/卸载自己的插件（VM 沙箱 + 审批门 + client half Worker 沙箱） | `selfmod/` |

关键入口：`createMiraContext()`（`framework/services.ts`）装配全部服务；`setupSelfModification()`（`selfmod/index.ts`）启用运行期自修改；`Agent.setMiraContext(ctx)` 让 Agent 循环获得插件扩展点（向后兼容，未注入时行为不变）。详细对标分析见 `docs/plugin-framework-comparison.md`。

### Agent 运行流水线
`Agent.run()` 分 5 阶段：`prepareRun → restoreSession → buildMessages → executeLoop → finalizeRun`。核心循环为双层结构：
- **外层**：消费 `PendingInputQueue`（FIFO + steer 优先）
- **内层**：ReAct reason-act 循环，每步经 `classifyStep` 分类（max-turns / failed / 重复文本 / 工具建议 / 完成），支持上下文自动重建（60% 触发）、token 预算闸门（`maxTotalTokens`）、工具收敛保护（连续 4 次搜索 / 8 次工具调用）

### 权限系统（三层 Gate）
- **Gate 1**：硬拒绝（`rm -rf /`、sudo、shutdown、fork bomb 等 `HARD_DENY_PATTERNS`）
- **Gate 2/3**：通配符规则匹配（`*` 单段 / `**` 多段）+ 模式叠加（硬规则 > base > mode > saved）
- **ApprovalStore**：TTL 300s 审批缓存 + `永远允许` 持久化到 SQLite
- bash 安全命令（`ls *`、`cat *` 等）自动放行，无需审批

### Goal Judge（任务完成度验证）
独立的验证 Agent，判断任务是否真正完成。防止 Agent 提前宣称"完成"。
配置：`goalDescription` + `judgeModel`，最多评估 12 次，连续失败 3 次自动终止。

### Max Mode（并行采样选优）
每轮并行生成 N 个候选方案（默认 5，clamp 2–8），由 judge 模型选出最优执行。
提升 10-20% 准确率，代价 4-5x token 消耗。

### Dream/Distill（记忆进化）
- **Dream**：扫描会话轨迹，提取持久知识到项目记忆（`.mira/knowledge/knowledge.json`）
- **Distill**：发现重复工作流，打包为可复用 skill/subagent
- 通过 `autoDreamHook` 停止钩子自动触发

### Dynamic Memory（动态记忆图谱）
基于记忆图谱的长期记忆系统（`memory/`）：
| 特性 | 说明 |
|------|------|
| **图谱结构** | 节点（importance/strength/衰减率）+ 边（relation/strength）+ 社区 + 嵌入 |
| **持久化** | SQLite `memory_nodes` / `memory_edges` / `memory_communities` / `memory_metadata` / `memory_embeddings` |
| **激活传播** | `memory-activation.ts` 图传播算法，命中节点沿边扩散 |
| **遗忘机制** | 衰减曲线（`decay-curve.ts`）+ 强度计算（`memory-strength.ts`），访问重置 |
| **中文支持** | 中文分词（`chinese-tokenizer.ts`）+ 同义词（`chinese-synonyms.ts` / `synonym-discovery.ts`） |
| **向量嵌入** | Transformers.js 本地 ONNX 推理 + 嵌入缓存（`embedding-cache.ts`） |
| **工具** | `memory_activate` + `memory_graph_*` 系列（导出但默认未注册） |

### Graph Engineering（图编排引擎）
Planner / Runtime / Recovery 三层分离的通用图编排引擎（`packages/core/src/graph/`）：

| 特性 | 说明 |
|------|------|
| **三层分离** | Planner（输入状态 → 图定义）、Runtime（图执行）、Recovery（失败收敛决策） |
| **节点种类** | `agent` / `subagent` / `judge` / `function` / `human` / `workflow` |
| **路由** | `next_node` 节点主动路由（运行时校验出边白名单）+ 确定性条件边（函数判断） |
| **失败回退** | 失败边重试（maxRetries）+ fallback 回退边 + 失败升级决策 |
| **State Schema** | 字段级类型声明 + replace/append/reducer 三种更新策略 + snapshot/mergePatch |
| **Checkpoint** | 每节点检查点，中断可从最后完成的节点恢复（resumeRunId） |
| **Token 预算** | 全局 Token 闸门 + Frozen Node 输出不可变 |
| **并行组** | `all_of` / `any_of` fan-out 多分支独立执行 → join 节点汇聚 |
| **节点契约** | contract 声明输入/输出，运行后引擎校验输出字段（防"假装完成"） |
| **Recovery 策略** | 单节点重入上限 + 全局执行上限 + onExhausted 升级（fail / escalate） |
| **模板** | `coding-task`（iterations 迭代收敛 + recovery 防死循环） |

### 组合模式（Compose Mode）
Phase 驱动的软件开发工作流（`compose-mode.ts`）：`plan → execute → review → test → debug → verify → merge`，每 phase 定义系统提示 + 工具白名单，通过 `SubagentManager` 派生子 Agent 执行（10 分钟超时）。

### Dynamic Workflow
代码级编排（`workflow/index.ts`）：主 Agent 生成 JS 脚本，通过 `agent()` / `bash()` / `parallel()` / `pipeline()` / `transform()` 步骤协调子 Agent。支持运行取消（AbortController）、步骤重试、变量注入。

### Subagent 管理
基于 Actor 模型的子 Agent 系统，支持以下功能：

| 特性 | 说明 |
|------|------|
| **调度模式** | `subagent`（共享会话）和 `peer`（独立工作目录） |
| **注册表持久化** | SQLite `actor_registry` 表，进程重启后自动恢复孤儿 Actor |
| **任务门控** | TaskGate 验证子 Agent 是否真正完成任务，最多 2 次自动重试，失败自动降级 |
| **标准化返回协议** | 子 Agent 按 `**Status**` / `**Summary**` 头块输出结构化结果 |
| **上下文继承** | 三种模式：`none`（只传 prompt）、`state`（注入 checkpoint 摘要）、`full`（共享前缀缓存） |
| **ReAct 循环** | preStop 循环（结果不符合预期时最多 3 轮自动补跑） + postStop 循环（完成后的跟进工作） |
| **粘滞检测** | 每分钟扫描，5 分钟无活动的子 Agent 自动标记为 `stuck` |
| **并发控制** | 最大并行 5（可配置），最大嵌套深度 8，总生命周期上限 100 |
| **状态机** | pending → running → completing → completed / failed / cancelled / orphaned / stuck |
| **通信总线** | 子 Agent 通过 `team-bus` 发送通知和结果给父 Agent |

### MCP（Model Context Protocol）
基于官方 `@modelcontextprotocol/sdk`，支持 `local`（StdioClientTransport）和 `remote`（StreamableHTTPClientTransport）服务器，工具名加 `{server}_` 前缀，运行时注册进 ToolRegistry。

### LSP（Language Server Protocol）
代码智能：定义跳转、引用查找、悬停、文件符号大纲、实现查找。手写 JSON-RPC over stdio 客户端（Content-Length 帧解析），支持 server→client 请求/通知分发。`server-defs.ts` 声明式定义语言服务器（当前内置 TypeScript，可扩展），`dependency.ts` 自动解析依赖（系统 PATH → 本地缓存 `userData/lsp/<id>/` → 白名单版本锁定自动安装），`indexing.ts` 追踪 `$/progress` 索引进度（跨文件查询前等待索引就绪），`diagnostic-check.ts` 提供编辑前后诊断对比（edit_file 写入后自动自检并返回新增错误/警告）。

### ACP（Agent Communication Protocol）
`orchestrate/acp/`：标准化的 Agent 间通信协议，含消息类型（20 个工厂函数）、`WorkStateMachine` 工作状态机 + 全局单例。

### 语音模块（Voice）
`voice/`（renderer-safe 纯入口 `@mira/core/voice`，可插拔引擎）+ `ui/services/voice/`（IPC 目录驱动获取层）：能量检测 VAD + 语音打断管理 + Whisper STT（本地 ONNX）+ Kokoro TTS，`VoiceChatButton` 一键实时语音对话。

**一切皆插件（引擎目录）**：引擎实现全部下沉 core（`voice/engines/`），目录数据三层合并（内置 `resources/models/voice-catalog.json` → 用户 `~/.config/mira/voice.json` → 插件 `PluginContext.registerVoice`），`VoiceRegistry`（纯注册表，无 Node）+ `catalog-loader`（Node fs，`initVoiceCatalog` 幂等装配）。UI 经 `config:getVoiceCatalog` / `config:saveVoiceConfig` IPC 拉取目录与默认选中项（`voice.json` 只存 `defaults` 装配，UI 开关 `voiceChatEnabled` 留在 localStorage）。Node 侧模块（`VoiceActivityDetector` / `InterruptionManager` / `AnnouncementWindow` / `catalog-loader`）仅经 `core/index` 导出，渲染进程经 `@mira/core/voice` 使用纯 TS 子集（`LightEmitter` 替代 Node events）。

### Widget 渲染
LLM 生成的 HTML 代码块在沙箱 iframe（`sandbox="allow-scripts"`）中渲染，自动注入本地 chart.js，支持查看代码/复制/下载。`widget-test.html` 提供测试入口。

### Live2D 桌宠
独立透明置顶窗口（`pet.html` + `PetApp.tsx`），Pixi.js 8 + untitled-pixi-live2d-engine 渲染，支持嘴型同步（ParamMouthOpenY）+ 直接对话 + 实时语音。设置页开关控制（`settings.live2dPet`），窗口位置记忆（`pet-bounds.json`）。

### Token 成本追踪
`shared/cost.ts`：内置 12+ 模型定价表（gpt-4o/o1/claude-sonnet-4/opus-4/deepseek 等），按 prompt/completion/cacheRead/cacheWrite 分项计费，会话级成本累加存入 SQLite `sessions.cost`。

## 聊天模块（Part 消息体系）

消息以 Part 数组结构存储，每个 Part 有独立类型和渲染方式：

| Part 类型 | 渲染组件 | 说明 |
|-----------|---------|------|
| `text` | MarkdownText（Streamdown） | 流式 Markdown 渲染，Shiki 代码高亮 |
| `thinking` | ThinkingBlock | AI 推理过程折叠面板 |
| `tool-call` | ToolCallView → 按工具名路由 | 自动路由到 ToolReadView/ToolShellView/ToolSearchView/ToolDiffView |
| `file` | 图片/文件内嵌 | 附件展示 |
| `diff-summary` | ToolDiffSummary | 回合级文件变更汇总（+N / -M） |
| `compaction` | 分割线 | 上下文压缩标记 |
| `widget` | WidgetRenderer | LLM 生成的 HTML 交互组件（沙箱 iframe） |

连续 `read_file`/`glob`/`grep`/`list_files`/`code_search`/`search_history` 工具调用自动聚合为 **ContextToolGroup** 折叠面板。

## assistant-ui 组件集成

项目使用 assistant-ui 作为聊天 UI 框架，采用 `ExternalStoreRuntime` 桥接自定义状态：

| 集成方式 | 组件 |
|---------|------|
| Runtime | `ExternalStoreRuntime` — 桥接 `useMiraChat` 状态 |
| Primitives | `ThreadPrimitive`、`MessagePrimitive`、`ComposerPrimitive` |
| Actions | `ActionBarPrimitive`、`BranchPickerPrimitive`、`SelectionToolbarPrimitive` |
| Markdown | `@assistant-ui/react-streamdown` — Streamdown（Shiki + Mermaid 内置） |
| Voice | `WebSpeechSynthesisAdapter`（TTS）、`WebSpeechDictationAdapter`（STT）+ 本地 ONNX Whisper/Kokoro |
| Files | `AttachmentAdapter` — 自定义文件上传 |
| Queue | `createMessageQueue` — 运行时允许排队发消息 |
| shadcn 组件 | ToolFallback、ToolGroup、Reasoning、DiffViewer、MessageTiming、ContextDisplay |

未使用内置 `<Thread />` 组件，而是用 Primitives 自行拼装以满足定制需求（Skill 补全/ModelSelector/WelcomeScreen）。

## IPC 通信

`preload.ts` 通过 `contextBridge` 暴露 `electronAPI`：

| 命名空间 | 功能 |
|---------|------|
| `agent.*` | Agent 流式执行、工具调用、权限回复、Skill 列表、追问建议 |
| `agent.question.*` | Agent 向用户提问与回答 |
| `agent.task.*` | 任务追踪 CRUD |
| `agent.subagent.*` | 子 Agent 生命周期控制 |
| `agent.goal.*` | Goal 管理 |
| `agent.dreamDistill.*` | Dream/Distill 记忆进化 |
| `agent.compose.*` | 组合模式全流程（17 个方法） |
| `agent.onEvent` | 监听 Agent 流式事件（按 channel 过滤） |
| `selfmod.*` | 运行期自修改（mira_plugin_* 工具执行 + client 代码执行 + 插件状态） |
| `config.*` | 配置读写（全局 JSON + 项目 JSON + Provider 目录 + 语音引擎目录 getVoiceCatalog / saveVoiceConfig） |
| `ts.*` | 项目/会话 CRUD、消息搜索、快照恢复、文件写入 |
| `memory.*` | 记忆搜索与状态查询（经 sidecar HTTP 代理） |
| `graph.*` | Graph 图编排执行（runCodingTask/状态/停止） |
| `live2d.*` | Live2D 桌宠开关 |
| `floatingBall.*` | 悬浮球开关/唤醒/隐藏/配置 + 状态监听 |
| `encryptApiKey` / `decryptApiKey` / `isEncryptionAvailable` | API Key 加密存储（Electron safeStorage） |
| `platform` | 当前平台标识 |
| `notify` | 系统通知 |
| `openFile` / `openDirectory` / `saveFile` | 文件/目录选择对话框 |
| `minimizeWindow` / `maximizeWindow` / `closeWindow` | 窗口控制 |

> **注意**：`preload` 中仍暴露 `getPythonStatus` / `getPythonLogs` / `clearPythonLogs` / `restartPython`（Python 遗留）和 `agent.chat` / `agent.runAgentStream`，但**均无对应 ipcMain handler**（死 API）。真实的流式执行走 `agent.startStream` → `sidecar-bridge` → Core HTTP SSE。`memory.searchByProject` / `memory.getGraphData` 已桥接进 `preload`（经 `memory-ipc.ts` 代理到 sidecar HTTP）。

## 数据库

SQLite (sql.js WASM) 表结构（`system/database.ts`）：

| 表 | 字段 | 说明 |
|----|------|------|
| projects | project_id, name, workspace_path, created_at | 项目 |
| sessions | session_id, project_id, title, workspace, created_at, updated_at, **cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write** | 会话（含成本/token） |
| messages | id, session_id, role, content, timestamp, tool_call_id, retry_count | 消息投影缓存（事件为唯一事实源） |
| permissions | workspace, action, resource, effect | 权限规则 |
| goals | session_id, id, description, created_at, status, satisfied_at, timeout_ms, evaluations_json | Goal 追踪 |
| actor_registry | actor_id, session_id, parent_actor_id, mode, status, description, context_mode, agent, result, error, turn_count, time_created, time_updated, time_completed, lifecycle | 子 Agent 注册表 |
| session_events | seq, session_id, type, payload, timestamp, version | 事件溯源日志（唯一事实源，`SessionEventMap` 可合并扩展） |
| event_snapshots | snapshot_id, session_id, up_to_seq, messages_json, metadata_json, created_at | 事件快照（避免全量回放） |
| todos | id, session_id, title, status, priority, parent_id, created_at, updated_at, completed_at | Todo 任务 |
| messages_fts | (FTS5 虚拟表) | 消息全文索引 |
| memory_nodes | id, content, type, importance, strength, access_count, last_accessed, created_at, community_id, decay_rate, min_strength, metadata_json, related_nodes_json, association_strengths_json | 记忆图谱节点 |
| memory_edges | id, source, target, relation, strength, created_at | 记忆图谱边 |
| memory_communities | community_id, node_ids_json | 记忆社区 |
| memory_metadata | key, value | 图谱元数据 |
| memory_embeddings | node_id, ... | 向量嵌入 |

## 架构说明（重要差异）

以下模块已实现并导出，但**当前未接入 Agent 循环**（保留代码 / 仅测试使用）：
- `llm/provider-chain.ts` + `llm/provider-policy.ts` — 真正的故障转移走 `orchestrate/failover.ts` 的 `FallbackClient`
- `agent/fork-cache.ts` — 分支缓存
- `agent/system-context.ts` — 系统级上下文（Agent 用 `session/context-source.ts` 的 SourceManager）
- `agent/run-coordinator.ts`、`system/tool-scope.ts` — 仅测试使用
- `agent/session-restore.ts` 的导出 `restoreSessionHistory` 与 `agent.ts` 私有实现重复

> **Cordis 适配层已接线**：`framework/`（Context/事件/插件桥）与 `services/`（`createMiraContext` 装配 12 个服务）已接入 `Agent.setMiraContext(ctx)` 与运行期自修改；`selfmod/` 经 sidecar HTTP + IPC 暴露给 UI。

## 开发指南

```bash
# 安装依赖（需要 pnpm）
pnpm install

# 启动开发模式
pnpm dev
# 或
.\start.ps1 dev

# 打包
pnpm package:win    # Windows
pnpm package:mac    # macOS
pnpm package:linux  # Linux

# 测试
pnpm test           # Vitest 4（66+ 文件，633+ 用例）

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint
pnpm lint:fix
```

## 环境要求

- Node.js 18+（corepack 随 Node 提供）
- pnpm 8+（根 `packageManager` 锁定 pnpm@11.9.0，推荐通过 `corepack pnpm` 使用）
- Windows / macOS / Linux
- **无需 Python**（Agent Core 完全由 TypeScript 实现）

## Understand Anything Dashboard（代码图谱可视化）

知识图谱仪表盘用于交互式浏览代码库结构。当用户说"看图谱"、"启动可视化"等时执行以下流程：

### 启动命令

```powershell
$env:GRAPH_DIR = "<项目根目录>"
Set-Location -LiteralPath "$HOME\.understand-anything\repo\understand-anything-plugin\packages\dashboard"
npx vite --host 127.0.0.1
```

### 路径信息

- 插件根目录：`C:\Users\Devenv114\.understand-anything\repo`
- 仪表盘目录：`$HOME\.understand-anything\repo\understand-anything-plugin\packages\dashboard`
- 知识图谱文件：`<项目根目录>\.understand-anything\knowledge-graph.json`

### 前置检查

1. 检查知识图谱是否存在：`Test-Path "<项目根目录>\.understand-anything\knowledge-graph.json"`
2. 如果不存在，提示用户先运行 `/understand` 命令
3. 检查 `$HOME\.understand-anything\repo\understand-anything-plugin\packages\core\dist\index.js` 是否存在，若不存在则构建 core 包

### Token 提取

从 Vite 启动输出中提取 `🔑 Dashboard URL: http://127.0.0.1:<PORT>/?token=<TOKEN>` 这行，向用户返回完整的带 token 的 URL。
