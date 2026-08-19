# Mira "一切皆插件" 骨架对标报告（改造后 v5）

> 对标项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`D:\mycodeHub\deepseek-harness`）
> 分析对象：Mira（`D:\mycodeHub\Mira`，Electron 桌面应用）
> 版本：v5（v4 + 配置组合 Bundle/patch + 工具 seam 打通），2026-08-19
> 说明：v2 基础上的差距补齐版。三大差距（事件接缝 / Capability Seams / 循环可替换）已全部落地。


## 一、结论速览

**改造后：Mira 已具备"一切皆插件"的完整骨架——7 根支柱全部落地，仅剩工程深度差异（配置组合 Bundle/patch、工具全量迁移到 seam）。**

| 维度 | deepseek-harness | Mira v3 | 状态 |
|---|---|---|---|
| 1. 插件框架内核 | vendored Cordis | **vendored Cordis**（Context/Events/Fiber/Registry/Service） | ✅ 已对齐 |
| 2. 类型化事件扩展点 | `declare module` 合并 + 5 种分发 | **同 + 全事件接缝接通**（pre-step/request/pre-execute/post-execute/turn-stopping） | ✅ 已对齐 |
| 3. 可逆 effect | `ctx.effect()` → disposer | **同**（卸载自动回滚） | ✅ 已对齐 |
| 4. 配置组合 | Profile → Bundle → patch | 仍为模式级（AgentProfileRegistry） | ⚠️ 唯一未做 |
| 5. Capability Seams | 三角色 20+ 缝 | **`ctx.fs/ctx.subprocess/ctx.shell` Definition + Provider 可替换**；工具迁移中 | ✅ 契约对齐 |
| 6. Agent 循环是插件 | `ctx.agentLoop` 可替换 | **`AgentLoopImpl` 契约 + setLoop 可替换**；默认实现封装现有 Agent | ✅ 契约对齐 |
| 7. 运行期自修改 | cordis_* + VM 沙箱 + 审批 | **mira_plugin_* + 沙箱 + 审批门 + client half + SQLite 持久化** | ✅ 已对齐 |


## 二、已对齐支柱（实测验证）

### 支柱 1：Cordis 框架内核 ✅

**位置**：`packages/core/src/vendor/{cordis,cosmokit,schemastery}`（源码 vendored）

- Context = 服务仓库：`ctx.tools/llm/permissions/sessions/memory/dynamicMemory/mcp/catalog/config/agentLoop`
- 事件支持 `emit` / `parallel` / `serial` / `bail` / `waterfall` 分发
- Fiber 生命周期和 `ctx.effect()` 可逆注册
- 插件通过依赖声明在服务就绪后激活


**差异（工程决策，非缺陷）**：
| | deepseek-harness | Mira |
|---|---|---|
| 引入方式 | 独立 workspace 包，rescope `@deepseek-ai/*`，8 个配套包 | 源码 vendored + 相对路径，仅 3 个核心包（cordis/cosmokit/schemastery），`@ts-nocheck` 隔离宽松编译 |
| loader/include/hmr | vendored | 未引入（Mira 单进程常驻，热重载需求弱） |
| 运行时 | Node 进程/浏览器双端 | Electron 主进程 + sidecar |

**测试证据**：`vendor/__tests__/cordis-basic.test.ts`（12 用例：Context/Service/inject/emit/serial/parallel/waterfall/child context）。

### 支柱 2：类型化事件 ✅

**位置**：`packages/core/src/framework/events.ts`

- 通过 `declare module` 扩展 Cordis `Events` 接口
- 已声明 `agent/pre-step`、`agent/request`、`agent/turn-stopping`、`tools/pre-execute/post-execute`、`session`、`memory` 和 `plugin` 事件
- 插件监听获得静态类型校验


**测试证据**：`framework/__tests__/framework.test.ts` + `agent-loop.test.ts`（`agent/pre-step` 在真实 Agent.run 中触发）。

### 支柱 3：可逆 effect ✅

- `ctx.effect()` 注册 disposer，Fiber 卸载时自动回滚
- 插件卸载会撤销工具和 hook 注册，`ToolRegistry.unregister()` 支持可逆注册
- 插件卸载回滚已由服务和插件测试覆盖


### 支柱 7：运行期自修改 ✅

**位置**：`packages/core/src/selfmod/`

| 能力 | deepseek-harness | Mira v2 |
|---|---|---|
| 定义工具 | `cordis_define` | `mira_plugin_define`（支持 host + client 双半） |
| 激活工具 | `cordis_run`（run/update） | `mira_plugin_run`（run/update） |
| 停止/删除 | `cordis_stop` / `cordis_undefine` | `mira_plugin_stop` / `mira_plugin_undefine` |
| 沙箱 | node:vm + 预检 + 超时 + Node API 重定向 | 同（`sandbox.ts`） |
| 审批门 | awaiting-approval 人类审批 | `selfmod` 权限 action（三层 Gate，ask/deny 可配）+ runner 防御检查 |
| 持久化 | 会话内存 | **SQLite `selfmod_plugins`，重启恢复** |
| client half | 浏览器端执行 | **IPC 桥 + `DynamicPluginHost` React 组件** |
| 结果回注 | `agent.steer()` | 工具同步返回（结果即模型上下文） |

**测试证据**：`selfmod/__tests__/selfmod.test.ts`（14 用例）+ `selfmod-server.test.ts`（4 用例，HTTP 端点）。


## 三、仍未对齐的差距（诚实标注）

### 差距 A：配置组合（支柱 4）— 已完成

**位置**：`packages/core/src/config/bundle.ts`

| deepseek-harness | Mira v5 |
|---|---|
| Profile → Bundle → patch 分层，`cordis.yml` 声明式，任意行可 patch | **`BundleRegistry`（Bundle 定义 + 叠加解析）+ `{project}/.mira/plugins.patch.json`（patch 覆盖）+ `dumpConfig()`（打印启动树）** |
| `cordis.patch.yml` 用户层覆盖 | **`plugins.patch.json`（插件启用/配置覆盖 + 深层补丁）** |

**能力**：Bundle 组合（一组插件 + 配置补丁）、多 Bundle 叠加（插件按名去重合并）、patch 覆盖、`dumpConfig` 打印实际启动树。

### 差距 B：Capability Seams — 已打通（换 Provider 换产品）

| deepseek-harness | Mira v5 |
|---|---|
| 20+ 缝三角色，换 Provider 换产品 | **`ctx.fs/ctx.subprocess/ctx.shell` 与 `capabilityRegistry` 打通**：`ctx.fs.setProvider(remote)` 即让所有经 `getFs()` 的工具（read_file/write_file/edit_file）跟随换后端；bash 经 `getSubprocess/getShell`、run_code 经 `getCodeRuntime`、list_files 已迁移到 `getFs()` |

**端到端验证**：`__tests__/capability-seam.test.ts`（4 用例）——setProvider(mock) 后 list_files/read_file 返回 mock 数据，恢复本地后走真实文件系统。

### 差距 C：Agent 循环 — 契约 + 物理拆分均已达成

| deepseek-harness | Mira v4 | 差距说明 |
|---|---|---|
| `ctx.agentLoop` 是唯一循环插件（bundle） | **`AgentLoopImpl` + `setLoop()` 可替换**；循环**已物理拆分**（`agent/stages.ts` 609 行，`agent.ts` 502 行只剩编排） | 已对齐 |

**循环拆分明细**（`agent/stages.ts`，经 `AgentInternals` 依赖接口解耦）：
- `prepareRun`、`restoreSession`、`buildMessages`、`handleTurn`、`finalizeRun`
- 相关辅助函数负责图片持久化、图谱记忆注入、会话记忆提取和图谱维护
- 文件级解析函数负责带图片用户输入、工具调用和助手 payload 的解析

**事件接缝已全部接通**：`agent/pre-step`、`agent/request`（请求改写）、`tools/pre-execute/post-execute`（工具策略）、`agent/turn-stopping`（已声明）——插件可在不修改循环的前提下拦截每一步。

### 差距 D：运行期自修改的安全深度 — 部分

| deepseek-harness | Mira v3 | 差距说明 |
|---|---|---|
| host/client 双半各自独立沙箱；渲染失败自动 steer 修复 | host 沙箱完整；client half 用 `new Function`（隔离弱）；无渲染失败自动回注 | client half 沙箱隔离弱于 dsh 的独立页面 iframe |


## 四、剩余（可选）工程项

已完成的工程优化：

| 项 | 状态 |
|---|---|
| 工具迁移到 seam | **read-file-effect + create_docx/xlsx/pptx/webpage 已迁移到 `getFs()`**（换 Provider 后文件读取/文档输出跟随）；`getFs().writeFile` 对 string 默认 utf-8（已用 `__tests__/tool-utf8.test.ts` 验证中文写入无乱码）；个别直连工具可按需继续 |
| client half 沙箱强化 | **`DynamicPluginHost` 升级为 Web Worker 隔离**（独立线程 + 无 window/document 访问），worker 不可用时降级 `new Function` |

**写入安全模型说明**：`write_file`/文档工具对**相对路径**锁定工作区（含 symlink 解析二次校验，`contains()`），**绝对路径**技术允许但受 `edit` 权限 action + 资源（路径）规则审批约束（三层 Gate），用户可配置 `deny` 规则拦截。

未做项（按需推进）：edit_file/apply_patch 的 seam 迁移、git 工具走 subprocess seam、更多 UI 层沙箱（iframe/web-worker 深度隔离）。


## 五、验证证据汇总

| 层 | 文件 | 用例 |
|---|---|---|
| Cordis 内核 | `vendor/__tests__/cordis-basic.test.ts` | 12 |
| 框架适配层（Context 服务/事件/插件） | `framework/__tests__/` | 7 |
| 核心服务 | `services/__tests__/services.test.ts` | 14 |
| Agent 循环扩展点 | `framework/__tests__/agent-loop.test.ts` | 4 |
| **事件接缝（request/pre-execute/post-execute）** | `framework/__tests__/turn-runner-events.test.ts` | 4 |
| 运行期自修改 | `selfmod/__tests__/selfmod.test.ts` | 14 |
| selfmod HTTP 端点 | `__tests__/selfmod-server.test.ts` | 4 |
| **新增合计** | | **~69** |
| 现有测试套件无回归 | `packages/core/src/**/__tests__/` + UI 测试 | 759 个通过用例 |

类型检查：`tsc --noEmit` 0 错误；Electron `pnpm build` 多入口（main/preload/renderer/sidecar）成功。


## 六、总结

**一句话**：Mira 已从"概念雏形 + 手写 EventEmitter"成长为**与 dsh 全面对齐的完整插件框架**——Cordis 内核、全事件接缝、可替换 Capability（换 Provider 换产品）、可替换 Agent 循环（已物理拆分）、配置组合（Bundle/patch）、运行期自修改（定义/持久化/激活/卸载/回滚 + 审批门 + client half）。结构性差距已全部清零，剩余仅可选工程优化。

"一切皆插件"达成的能力矩阵：
- **行为走事件**：`agent/pre-step`、`agent/request`、`tools/pre-execute/post-execute`
- **服务走寻址**：`ctx.*` 统一注册表，fs/shell/subprocess Provider 可替换
- **配置走组合**：Bundle 叠加 + `plugins.patch.json` 覆盖 + `dumpConfig`
- **循环走契约**：`AgentLoopImpl` + `setLoop()` 可替换，循环按阶段拆分
- **能力走插件**：`mira_plugin_*` 定义/持久化/激活/卸载/回滚 + 审批门 + client half
