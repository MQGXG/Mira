# Mira Cordis 深度对齐实施计划 v2（以 deepseek-harness 最新为准）

> 对标项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`D:\mycodeHub\deepseek-harness`，2026-08-19 拉取最新）
> 分析对象：Mira（`D:\mycodeHub\Mira`）
> 计划版本：v2，2026-08-19（v1 → v2 修订说明见文末）
> 前置文档：`docs/plugin-framework-comparison.md`（v5）

---

## 一、v2 决策（用户确认，2026-08-19）

| # | 决策 | 影响 |
|---|------|------|
| D1 | **该重写的重写**：接口不匹配 dsh 的实现重写为 dsh 形态，不将就旧代码 | 批 2/3/4 从"最小改动"改为"对齐重写" |
| D2 | **保证原功能不受影响、效果一样**：行为语义回归受控，每批 typecheck + 测试全绿 | 执行纪律（回归基线 719 passed \| 5 skipped） |
| D3 | **不用兼容旧，以 dsh 最新为准**：兼容层移除（`mcp.bindRegistry` 等）；不保留旧 API 的兜底 | 接口面直接对齐最新签名 |
| D4 | **特色模块不删除**：记忆/图谱/Live2D/语音/Compose/Max Mode/Graph Engineering/双层循环等全部保留 | 对齐对象是装配机制与公共接口，不是领域功能 |
| D5 | **该统一接口都应该统一**：`ctx.*` 服务面（tools/agents/agentLoop/sessions/systemPrompt/llm）命名、签名、语义统一到 dsh | 全批总纲 |

---

## 二、目标接口面（对齐 dsh 最新，2026-08-19 核验）

dsh `packages/core` 最新结构：`agent` / `agent-loop` / `scope` / `session` / `system-prompt` / `tools` / `agent-tool-presentation` / `agent-default-model`。

### 2.1 scope 原语（新增模块 `packages/core/src/scope/`，移植 dsh `packages/core/scope/src`）

| API | 语义 | 位置 |
|-----|------|------|
| `createScope(ctx, key, options?)` → `{ ctx, rawDispose, dispose }` | 铸一个注册作用域 ctx，可绑定父链 | `scope/src/index.ts:137` |
| `bindScopeParent` / `scopeParentOf` / `scopeChainOf` | 作用域父子链（防环） | `:72,:89,:98` |
| `scopeOf(ctx)` | 读 ctx 最近作用域标签 | `:154` |
| `scopeTarget(base, key)` → `Scoped<T>` | 路由事件 carrier（祖先收后代事件，事件向上流动） | `:170` |
| `isScopeCarrier` / `carrierKeyOf` | carrier 判别/取键 | `:192,:201` |
| `ScopedLayers` / `NamedEntries` / `AnonymousEntries` | 全局层 + 作用域层存储（注册即 effect 归属） | `scope/src/store.ts` |

> **修订**：v1 曾决策"复用原生 `ctx.extend`/`ctx.isolate`，不移植 scope"。用户 D1/D5 后改为**移植**——scope 是 dsh 全部服务（tools/agent/agent-loop）的底层原语，统一接口必须先统一它。Mira vendored cordis 已具备其依赖（`ctx.extend({symbol})`、`ctx.plugin`、`ctx.effect` 生成器、`Context.filter`），零兼容成本。

### 2.2 tools 服务（重写 `services/tools.ts` → `ctx.tools` 对齐 `ToolRuntime`）

| 接口 | dsh 签名 | Mira 现状 | 动作 |
|------|----------|-----------|------|
| `register(tool)` | 返回 **exact disposer**；ScopedLayers 全局/作用域层；重复名报错 | `register()` 返回 void；`registerEffectively` 手工 disposer | **重写** |
| `restrict(filter)` | 作用域过滤全局工具（allow/deny），返回 disposer | 无（`materializeScoped` 命令式 filter） | **新增** |
| `guard(guard)` | 单调守卫（pre-execute 后、body 前），返回 disposer | `pre_tool_use`/`pre_tool_execute` hook | **新增**（承接批 4） |
| 执行管线 | `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` 事件（scope-filtered）+ 权限 | `registry.execute` + permission Gate + hook | **统一事件面** |
| `presentCall`/`presentResult` | 工具声明 UI 呈现意图（ToolCallView/ToolResultView） | `ui/tool-views` 命令式路由 | **接口统一**（可选，UI 层适配） |
| `tools/change` 事件 | 注册/限制变化通知 | 无 | **新增** |

### 2.3 agents 服务（新增 `services/agents.ts` → `ctx.agents` 对齐 `AgentRegistry`）

| 接口 | dsh 签名 | Mira 现状 | 动作 |
|------|----------|-----------|------|
| `register(agent)` / `enter` / `announce` | 注册/发布 Agent，返回 disposer，发 `agent/created`/`agent/disposed` | 无 | **新增** |
| `setFactory(factory)` | 注册 AgentFactory（agentLoop 实现），返回 disposer | 无 | **新增** |
| `create(options)` / `resume(options)` | 经 factory 委托，返回 `AgentHandle { agent, dispose }` | 无 | **新增** |
| `get(id)` / `list()` / `roots()` / `isOwnedBy` | 实时注册表查询 | SubagentManager（Actor 体系） | **新增**（Subagent 保留） |
| `currentInitiator` / `withInitiator` | 进程内发起者因果链（AsyncLocalStorage） | 无 | **新增** |
| `ctx.agent` | DX accessor（当前 agent） | 无 | **新增** |
| `agent/session-start` 事件 | scope-target 广播 | `session_start` hook（批 4 迁移） | **统一** |

> Mira 的 `SubagentManager`（Actor 状态机/TaskGate/team-bus）是特色，**不删除**；其与 `ctx.agents` 的关系：Subagent 子 Agent 注册进 `ctx.agents`（同一实时面），状态机保留在 `orchestrate/subagent.ts`。

### 2.4 agentLoop 服务（重写 `services/agent-loop.ts` → 对齐 dsh `AgentLoop`）

| 接口 | dsh 签名 | Mira 现状 | 动作 |
|------|----------|-----------|------|
| 类形态 | `AgentLoop extends Service implements AgentFactory`；`static inject = ['agents','sessions','llm','tools','systemPrompt']` | `MiraAgentLoopService` + `AgentLoopImpl` 契约 | **重写** |
| `createAgent(ownerCtx, options): Promise<AgentHandle>` | 异步、owner 所有权、setup 事务 | 同步 `createAgent(config): Agent` | **重写签名** |
| `resume(ownerCtx, options)` | 从持久化恢复 | `resumeAgent` 同步 | **重写签名** |
| `setLoop` / `getLoop` | 无（循环=插件本身，替换=换插件） | 有（可替换循环） | **收敛**：保留为 `AgentLoopImpl` 内部，循环插件化 |
| scope 使用 | `prepare()` 铸 agent scope（`createScope`），发布前注册 teardown | 无 | **新增** |

> **保留（D4）**：Mira 双层循环（PendingInputQueue + ReAct/classifyStep）、5 阶段流水线、上下文重建、maxTotalTokens 闸门、工具收敛保护、Doom Loop/N-gram 全部保留。重写的是**装配面**（scope 铸造、registry 发布、owner 所有权、异步 createAgent 契约），不是循环语义。

### 2.5 sessions / systemPrompt / llm 服务（接口统一）

| 服务 | dsh 形态 | Mira 现状 | 动作 |
|------|----------|-----------|------|
| `ctx.sessions` | `sessions.enter(session)` / `announce(session)` / `prepare(id, opts)` / `get/list` | CRUD（createSession/get/list/delete） | **接口对齐**（保留 CRUD 特色 + 增 enter/announce/prepare 面） |
| `ctx.systemPrompt` | `variable(name, fn)` / `section({name,order,text})` / `tools(fn)` | `SourceManager`（7 种 Source）+ `agent/system-context.ts` | **统一**：新增 `systemPrompt` 服务包装 SourceManager，对齐 variable/section/tools |
| `ctx.llm` | `createClient` / 模型路由 | `createClient(config)` / `listModels` | **基本对齐**（保留） |
| `ctx.catalog` / `ctx.config` / `ctx.permissions` / `ctx.memory` / `ctx.dynamicMemory` / `ctx.mcp` / `ctx.capability` | Mira 特色服务面 | 已有 | **保留**（D4），补齐 `static inject`/`static provide` 声明（批 1 已做） |

---

## 三、分批实施计划（v2 修订）

### 批 1（✅ 已完成，2026-08-19）：服务声明式化 + effect 接缝

- 11 服务补 `static provide` + config 化构造；`createMiraContext` 改 async + `ctx.plugin()` 装配；49 处调用点 `await` 化；修复 agentLoop 注入根 ctx。
- 基线：typecheck ✅，test 719 passed | 5 skipped ✅。
- **v2 追加（待做）**：移除 `services/mcp.ts` 的 `bindRegistry` 兼容层（无调用方）。

### 批 2（P0，v2 重写）：scope 原语移植 + tools 服务 ScopedLayers 化

**目标**：移植 dsh scope 包；`ctx.tools` 重写为 ScopedLayers 形态（全局 + 作用域层），register 返回 disposer、新增 restrict/guard、执行管线事件化。

**改动清单**：

| 文件 | 改动 |
|------|------|
| `scope/`（新增） | 移植 `index.ts` + `store.ts`（去掉 `.ts` 后缀引用，适配 vendored cordis 导入路径） |
| `services/tools.ts` | 重写：`ToolRegistry` → `ScopedLayers`（`ToolLayer`：NamedEntries tools + AnonymousEntries restrictions/guards）；register 返回 disposer；新增 restrict/guard；保留 `registry` 兼容导出（48 工具 + MCP/Plugin 注册面不动） |
| `system/tool-scope.ts` | `ScopedToolRegistry` 保留（作为历史命令式物化），`materializeScoped` 改走 ScopedLayers 链式解析 |
| `framework/context.ts` | `ToolService` 接口更新：register 返回 disposer、新增 restrict/guard |
| `services/mcp.ts` | 移除 `bindRegistry`；构造从 `this.ctx.tools` 解析 registry（注入已有） |

**验收**：typecheck + test 全绿；`tools.register(...)` disposer 可逆卸载；作用域工具 shadow 全局；现有 48 工具 + MCP/Plugin 注册行为不回归。

### 批 3（P0，v2 新增）：agents 服务 + agentLoop factory 化

**目标**：建立 `ctx.agents`（AgentRegistry 对齐 dsh），`ctx.agentLoop` 重写为 `AgentFactory` 实现。

**改动清单**：

| 文件 | 改动 |
|------|------|
| `services/agents.ts`（新增） | `AgentRegistry`：register/enter/announce/get/list/roots/isOwnedBy/setFactory/create/resume + initiator（AsyncLocalStorage）+ `ctx.agent` accessor |
| `services/agent-loop.ts` | 重写为 `MiraAgentLoop extends Service implements AgentFactory`：`static inject = ['agents','tools','sessions','llm','catalog']`；`createAgent(ownerCtx, opts): Promise<AgentHandle>`（铸 agent scope → setup → publish → 启动）；`resume` |
| `agent/agent.ts` | Agent 增加 `id`（=sessionID）与 `ctx`（agent scope context）暴露；`setMiraContext` → `ctx.agents.register` 语义对齐 |
| `framework/context.ts` | `AgentLoopService`/`AgentFactory`/`AgentHandle`/`AgentRegistry` 类型声明 |
| `orchestrate/subagent.ts` | Subagent 创建走 `ctx.agents.create`（ownerCtx = 父 agent ctx），状态机/TaskGate 保留 |

**验收**：typecheck + test 全绿；`ctx.agents` 查询/发布/销毁语义对齐；Agent 双层循环行为不变；Subagent 状态机不回归。

### 批 4（P1，v2 重写）：统一事件面 + 移除兼容层

**目标**：pluginHooks 9 事件迁移到 Cordis events（dsh 命名）；工具执行管线事件统一（`tools/pre-execute`/`post-execute`）；`systemPrompt` 服务统一 SourceManager。

**改动清单**：

| 文件 | 改动 |
|------|------|
| `shared/plugin-hooks.ts` | 标记废弃，薄包装到 Cordis events |
| `agent.ts` / `turn-runner.ts` / `stages.ts` | pre_llm→`agent/request`（dsh 语义）、pre_tool_use→`tools/pre-execute`、post_tool_use→`tools/post-execute` 等，scope-filtered |
| `framework/events.ts` | 声明 dsh 命名事件（agent/created、agent/disposed、agent/session-start、tools/*） |
| `services/system-prompt.ts`（新增） | `variable`/`section`/`tools` 面包装 SourceManager |
| `services/mcp.ts`、`services/capability.ts` | 清理兼容字段 |

**验收**：typecheck + test 全绿；9 事件语义等价（bail/waterfall 映射正确）；插件 API hook 兼容。

---

## 四、特色保留核查（v2 更新）

| 特色 | 位置 | 保留策略 |
|------|------|----------|
| 双层循环 + classifyStep + 5 阶段流水线 | `agent/agent.ts`、`input-queue.ts` | ✅ 语义不动；批 3 只改装配面 |
| 上下文 60% 重建 / maxTotalTokens / 工具收敛保护 | `agent.ts` | ✅ 不动 |
| 权限三层 Gate + ApprovalStore | `permission/` | ✅ 服务内部逻辑不动 |
| 48 默认工具 + MCP/Plugin 动态注册 | `system/registry-init.ts`、`mcp/` | ✅ 注册面经 ScopedLayers 承载，工具定义不动 |
| Subagent（Actor 状态机/TaskGate/team-bus） | `orchestrate/subagent.ts` | ✅ 状态机不动；创建路径接 `ctx.agents` |
| 记忆 6 层 Provider + Dynamic Memory 图谱 | `memory/` | ✅ 不动 |
| Compose / Max Mode / Goal Judge / Graph Engineering | `compose-mode.ts`、`max-mode.ts`、`goal-judge.ts`、`graph/` | ✅ 不动 |
| Live2D / 语音 / Widget | `apps/desktop`、`voice/` | ✅ 不动 |
| stop-hooks（autoDream/memoryPromote） | `stop-hooks.ts` | ✅ 独立系统，不动 |
| token 成本追踪 | `shared/cost.ts` | ✅ 不动 |

**核查结论**：对齐对象=装配机制 + 公共接口；领域功能零删除、语义零变化。

---

## 五、执行纪律

1. 每批独立：完成 → `pnpm typecheck` + `pnpm test` 全绿 → 提交 → 下一批。
2. 回归基线：719 passed | 5 skipped（2026-08-19）。
3. 若某批执行中发现特色语义变化，立即停止该批并回报。
4. 批次顺序：批 2 → 批 3 → 批 4（批 1 已完成）。

---

## 附：v1 → v2 修订说明

- **v1 决策"不移植 dsh scope 包"** → 改为**移植**（D1/D5）：scope 是 dsh 服务统一接口的底层原语。
- **v1 批 2 工具作用域"ScopedToolRegistry 扩展"** → 改为 **ScopedLayers 重写 `ctx.tools`**（register 返回 disposer + restrict/guard + 管线事件化）。
- **v1 批 3 "agent-loop 插件化"** → 升级为**新增 `ctx.agents` 服务 + agentLoop 实现 AgentFactory**（createAgent/resume 异步 owner 契约）。
- **v1 批 4 hook 迁移** → 升级为**统一事件面**（dsh 命名事件 + tools 管线事件 + systemPrompt 服务）。
- **新增**：D3 移除兼容层（mcp.bindRegistry 等）；v1 的"机制对齐、语义保留"决策仍生效（双层循环保留）。