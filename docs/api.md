# Mira API 文档

## 概述

Mira 采用 Electron IPC 通信（**不使用 HTTP API**）。所有通信通过 `contextBridge` 暴露的 `electronAPI` 进行。
实际 API 面定义在 `packages/electron/src/preload/index.ts`（`type ElectronAPI = typeof electronAPI`），以下为完整清单。

> **注意**：`agent.chat` / `agent.runAgentStream` / `getPythonStatus` 等为死 API（preload 暴露但无 ipcMain handler），真实流式执行走 `agent.startStream`。

## 全局方法

| 方法 | 类型 | 说明 |
|------|------|------|
| `minimizeWindow()` / `maximizeWindow()` / `closeWindow()` | send | 窗口控制 |
| `openFile()` / `openDirectory()` / `saveFile(name)` | invoke | 文件/目录选择对话框 |
| `notify(title, body)` | invoke | 系统通知 |
| `encryptApiKey(text)` / `decryptApiKey(enc)` / `isEncryptionAvailable()` | invoke | API Key 加解密（Electron safeStorage） |
| `platform` | 常量 | 当前平台标识 |

## `config.*` — 配置系统

| 方法 | 说明 |
|------|------|
| `get(workspace?)` | 获取配置（全局 JSON + 项目 JSON + env 合并） |
| `save(config)` | 保存配置 |
| `getProviderCatalog()` | 获取 Provider 目录 |

## `ts.*` — 会话/项目

| 方法 | 说明 |
|------|------|
| `listProjects()` / `createProject(name, workspace)` / `updateProject(id, data)` / `deleteProject(id)` | 项目 CRUD |
| `createSession(projectId, title?)` / `listSessions(projectId?)` / `deleteSession(id)` / `updateSession(id, {title})` | 会话 CRUD |
| `getSessionMessages(sessionId)` | 获取会话消息 |
| `deleteMessage(sessionId, messageId)` | 删除单条消息 |
| `searchMessages(query)` | 跨会话搜索消息 |
| `restoreSnapshot(snapshotId, workspace)` | 恢复文件快照 |
| `writeFile(filePath, content)` | 写入文件 |

## `agent.*` — Agent 执行

| 方法 | 说明 |
|------|------|
| `executeTool(name, args)` | 直接执行工具（不经 LLM） |
| `listTools()` / `listAgents()` | 列出工具 / Agent 模式 |
| `startStream(sessionId, message, config)` | **实时流式执行**（SSE via sidecar） |
| `replyPermission(channel, requestId, reply)` | 回复权限请求（allow/deny/always） |
| `stopStream(channel)` | 停止流 |
| `suggestFollowUps(sessionId)` | LLM 生成追问建议 |
| `listSkills()` | 列出可用 Skill |
| `onEvent(channel, cb)` | 监听 Agent 流式事件（返回取消函数） |

### `agent.question.*`

| 方法 | 说明 |
|------|------|
| `answer(questionId, answer)` | 回答 Agent 提问 |
| `listPending()` | 列出待处理提问 |

### `agent.task.*`

`create(summary, parentId?)` / `updateStatus(id, status)` / `updateSummary(id, summary)` / `addNote(id, note)` / `get(id)` / `list(status?)` / `listActive()` / `toText()`

### `agent.subagent.*`

`spawn(description, options?)` / `wait(id, timeoutMs?)` / `cancel(id)` / `get(id)` / `list(filter?)` / `listActive()` / `cancelAll()` / `toText()`

### `agent.goal.*`

`set(description, timeoutMs?)` / `getActive()` / `list()` / `cancel()` / `toText()` / `load(sessionID)` / `save()`

### `agent.dreamDistill.*`

`dream(history, config)` / `distill(history, config)` / `getKnowledge()` / `toText()`

### `agent.compose.*`

`start(spec)` / `getState()` / `getCurrentSkill()` / `advance()` / `goTo(phase)` / `update(updates)` / `addCodeFile(path)` / `addReviewComment(comment)` / `addTestResult(result)` / `addDebugLog(log)` / `setVerificationPassed(bool)` / `complete()` / `cancel()` / `getHistory()` / `toText()` / `getSkills()` / `getPhaseOrder()`

## `graph.*` — Graph 图编排

| 方法 | 说明 |
|------|------|
| `runCodingTask(request, config, options?)` | 运行 coding-task 图 |
| `getStatus(runId)` | 运行状态 |
| `listRuns(graphId?)` | 历史运行 |
| `stop(runId)` | 停止运行 |

## `memory.*` — 记忆系统

| 方法 | 说明 |
|------|------|
| `search(query, type?, limit?)` | 记忆全文搜索 |
| `searchByProject(query, projectId, limit?)` | 按项目记忆搜索（经 sidecar HTTP 代理） |
| `getGraphData()` | 获取 Dream 记忆图谱实体/关系 |
| `status()` | 记忆状态 |

> `memory.*` 全部经 `memory-ipc.ts` 代理到 sidecar HTTP，均已桥接进 preload。

## `live2d.*`

`toggle(enabled)` — 打开/关闭 Live2D 桌宠窗口。

## `floatingBall.*` — 桌面悬浮球

`toggle(enabled)` / `wake()` / `hide()` / `updateConfig(config)` / `onStateChange(cb)` / `dragStart(pt)` / `dragMove(pt)` / `dragEnd()` / `click()` / `closePanel()` / `sendMessage(text)` / `onMessage(cb)`

> 悬浮球默认不创建（懒加载），`sendMessage` 仅回显，未接入真实 Agent。

## 死 API（无 ipcMain handler）

| API | 说明 |
|-----|------|
| `getPythonStatus` / `getPythonLogs` / `clearPythonLogs` / `restartPython` | Python 遗留（项目零 Python 依赖） |
| `agent.chat` / `agent.runAgentStream` | 旧执行入口，真实流式走 `agent.startStream` |

> 流式事件监听统一使用 `agent.onEvent(channel, cb)`（preload 内封装，非独立 API）。
