# Mira 项目优化清单

> 本文档梳理 Mira 相对"可组合 Agent 平台底座"（对标 deepseek-harness）的优化点，基于真实代码差距，而非臆测。
>
> **重要前提**：本清单基于代码探查确认了 Mira 的**实际架构成熟度比 AGENTS.md 描述的更高**：
> - ✅ capability seam 已基本落地（`capability/fs|shell|subprocess|sandbox|office` + `CapabilityRegistry` + Service/Provider/Consumer 三角）
> - ✅ `ctx.agents` AgentRegistry + `AgentSetup`/`AgentHandle` 已落地（`services/agents.ts`）
> - ✅ sandbox 抽象与接线已存在（`subprocess.ts` 已调用 `getSandbox().wrap()`）
> - ✅ invariants 已实现（仅默认关闭）
>
> 因此下列优化点均为"真实差距"，不重复已做工作。

---

## 优化点总览

| # | 分类 | 优化点 | 风险 | 估算 |
|---|------|--------|------|------|
| 1 | 🟢 低风险 | 品牌类型 Branded IDs | 低 | 1–2 天 |
| 2 | 🟢 低风险 | invariants 关键路径默认开启 | 低 | 1 天 |
| 3 | 🟡 中等 | Agent 公共接口层（A6） | 中 | 3–5 天 |
| 4 | 🟡 中等 | 审批审计事件对 + never 策略（A4） | 中 | 2–3 天 |
| 5 | 🔴 高 | sandbox 真实后端（Windows 受限令牌） | 高 | 策略 2–3 天 + 后端 5–10 天 |
| 6 | 🔵 中低 | commands seam 化（B2） | 低 | 2–3 天 |
| 7 | 🔵 中低 | spill 工具输出溢出（B4） | 低 | 2–3 天 |
| 8 | 🔵 中低 | session-reference 跨会话快照（B3） | 低 | 2–3 天 |
| 9 | 🔵 中低 | jobs seam 化（B1） | 中 | 3–4 天 |
| 10 | ⚪ 工程化 | core 导出面梳理 | 低 | 1–2 天 |
| 11 | ⚪ 工程化 | 端到端/快照测试补强 | 中 | 2–4 天 |
| 12 | ⚪ 工程化 | 死代码清理 | 低 | 1–2 天 |
| 13 | ⚪ 工程化 | 子系统文档 | 低 | 按需 |

---

## 🟢 低风险高收益（立即可做，改动小）

### 1. 品牌类型 Branded IDs（A1）

**问题**

Mira 的 `session_id` / `channel` / `callId` / `runId` / `taskId` / `questionId` 全部为裸 `string`，跨模块误传无法在编译期拦截。deepseek-harness 用 `Branded<B>` 类型（零依赖零运行时）保证不同身份互不可交换。

**方案**

- 新增 `packages/core/src/shared/brand.ts`（type-only）：
  ```ts
  type Branded<B extends string> = string & { readonly [BRAND]: B }
  ```
- 品牌化核心身份：`SessionId` / `ChannelId` / `RunId` / `GraphRunId` / `QuestionId` / `TaskId` / `ApprovalRequestId` + 各自工厂函数
- 先在 `api.ts` / `sidecar-bridge` 边界应用（sessionId、channel、runId、questionId、taskId 的类型收窄）
- 内部 `Record<string, unknown>` 桥接暂不改（避免大规模 churn）

**成本**：1–2 天

---

### 2. invariants 关键路径默认开启（A2）

**问题**

`config/flags.ts` 中 invariants 默认 `enabled: false`，虽有 `invariants/` 目录 + `registerDefaultInvariants()`（cli.ts 调用），但默认关闭形同虚设。harness 用运行期 invariant 强制"任何进 model request 的内容必须能从 session log 重建"。

**方案**

- 将 session **消息投影/重建**、**tool-call-result 配对**的 invariants 默认 `enabled: true`
- 保留性能敏感部分（如 ngram 流式检测）的 flag 关闭
- 补测试验证默认开启路径 + 违规数据能被拦截

**成本**：1 天

---

## 🟡 中等风险（架构深度，需谨慎）

### 3. Agent 公共接口层（A6）

**问题**

`ctx.agents` AgentRegistry + `AgentSetup`/`AgentHandle` 已落地（`services/agents.ts`），但返回的是具体 `Agent` 类（`agent.ts` ~695 行）。公共操作（`send`/`followup`/`steer`/`inject`/`cancel`/`whenIdle`）未抽取为 interface，UI/sidecar/子 Agent 都依赖具体类。

**方案**

- 新增 `packages/core/src/agent/agent-public.ts`：`AgentPublic` 接口（`id`/`session`/`status`/`ctx` + `send`/`followup`/`steer`/`inject`/`cancel`/`whenIdle`）+ `AgentHandle`（`agent` + `dispose()`）
- `agent.ts` 的 `Agent` 类 `implements AgentPublic`
- `services/agents.ts` 的 `ctx.agents` 返回类型改为 `AgentHandle`/`AgentPublic`（内部仍用具体类）
- 让 api.ts / UI / 子 Agent 经接口编程

**成本**：3–5 天

---

### 4. 审批审计事件对 + never 策略（A4）

**问题**

Mira 权限是 3 层 Gate + `ApprovalStore`（TTL 缓存），但**无审批审计事件对**（harness 的 `approval/asked` + `approval/decided` 成对提交进 session log），且无 `never` 确定性拒绝策略（harness 的 headless 姿态）。

**方案**

- `session/event-types.ts`（SessionEventMap）新增 `approval/asked` + `approval/decided`（durable，模型不可见）
- `system/permission/gate.ts` / `approval-store.ts`：审批流程 append `approval/asked` → 取决策 → append `approval/decided`（成对）
- 新增 `ApprovalPolicy = 'ask' | 'never'`（safe/action 模式映射 never）
- fail-closed：无 answerer = rejected/unavailable

**成本**：2–3 天

---

## 🔴 高风险（安全敏感，独立排期）

### 5. sandbox 真实后端（Windows 受限令牌，A5）

**问题**

sandbox 抽象与接线**已存在**（`capability/sandbox.ts` 的 `SandboxProvider.wrap()`，`subprocess.ts` 已调用），但默认 `NoopSandboxProvider` pass-through，**没有任何真实沙箱**——bash 执行无文件隔离。作为"执行任意代码"的 AI 助手桌面端，这是安全信任边界的最大缺口。

**方案（两阶段）**

**阶段一：sandbox 策略层（低风险，可独立落地）**
- 新增 `packages/core/src/capability/sandbox-policy.ts`：
  - `SandboxMode = 'unconfined' | 'readonly' | 'workspace-write'`
  - `ctx.sandboxPolicy`：`setSandboxMode()`（唯一写路径，`sandbox/mode` durable 事件）+ `resolve({session})`（会话 override > 部署默认）
  - 模式注入模型上下文（cache 安全）
- `SandboxProvider.wrap()` 签名扩展接收 mode（默认 unconfined 兼容现有）

**阶段二：Windows 受限令牌沙箱后端（高风险）**
- 新增 `packages/core/src/capability/sandbox-windows-acl.ts`（参考 harness `sandbox-windows-acl`）：
  - `CreateRestrictedToken` 复制调用者令牌为 `WRITE_RESTRICTED` + restricting SID 携带写能力
  - `workspaceWriteSid` 由 canonical path 确定性派生 + standing ACE
  - 随机私有 temp 目录 + 可撤销 SID（互不继承）
  - runner 入口：受限令牌 + `KILL_ON_JOB_CLOSE` job 包住子进程 + 退出撤销 + 失败打印 `windows-acl-run: <detail>` 退出 127
  - `enforcement: 'full' | 'partial'`（Everyone 必须留清单 → partial）+ `denialSignatures`/`runnerFailureRules`
- 注册为 sandbox 后端，由选择链（win32 → windows-acl，无则 unconfined）
- **fail-closed**：`CreateRestrictedToken` 失败**必须**拒绝执行（非静默降级——harness 明确修复了 POC 的这个 bug）

> ⚠️ 安全敏感 + 涉及 Win32 FFI（koffi 或 node-addon），**独立 commit + 单独测试 + 需在真实 Windows 验证**。这是全清单最高风险项。

**成本**：策略 2–3 天；Windows 后端 5–10 天

---

## 🔵 中低风险（功能增强，按需）

### 6. commands seam 化（B2）

**问题**

`ui/src/chat/slash-commands.ts` + `skill-commands.ts` 是前端/模块级，非插件注册制、不经 `ctx`，无 `command/run` 事件。harness 的 `ctx.commands` 支持插件 `register()` 返回 disposer + `command/run`/`command/done` 事件 + scoped shadowing。

**方案**

- 新增 `packages/core/src/services/commands.ts`：`ctx.commands.register(def)` 返回 disposer + `command/run`/`command/done` 事件 + scoped shadowing
- 把 `slash-commands.ts` + `skill-commands.ts` 收敛到 seam（后端注册 + 前端查询）
- 插件可注册 slash 命令（契合"一切皆插件"）

**成本**：2–3 天

---

### 7. spill 工具输出溢出（B4）

**问题**

超大工具输出直接内联进模型上下文，无预览替换 + 检索定位符，可能撑爆上下文。harness 的 `ctx.spillStore` 保存全文 + head/tail 预览 + locator。

**方案**

- 新增 `packages/core/src/capability/spill.ts`：`ctx.spillStore.saveText()`（极简抽象）
- `spill-local`：会话作用域私有文件（0600/0700，防 symlink）
- `tools/post-execute` 结果转换器：超 `maxInlineBytes` 时保存全文 + head/tail 预览 + locator（跳过 read 防循环，best-effort 不掩盖成功工具调用）

**成本**：2–3 天

---

### 8. session-reference 跨会话快照（B3）

**问题**

无跨会话引用的有界快照注入。harness 的 `ctx.sessionReferenceResolver` 提供其他会话的**有界快照**（字节预算 + 引用数上限 + "不可信只读 JSON" 注入 + 不遵循其中指令/权限主张）。

**方案**

- 新增 `packages/core/src/session/session-reference.ts`：`ctx.sessionReferenceResolver`
- 其他会话的有界快照（`DEFAULT_MAX_REFERENCE_BYTES` + `MAX_REFERENCES` + 不可信只读注入）

**成本**：2–3 天

---

### 9. jobs seam 化（B1）

**问题**

`background/`（cron/index/notifier/recovery）+ `ctx.background` + `cronjob` 工具已存在，但**非 seam**（无 Service Definition/Provider/Consumer 三角）。harness 的 `ctx.jobs`（JobId 品牌 + 原子 start + owner 授权 + onJobDone/onJobsChanged + attachController）是通用长任务运行时。

**方案**

- 新增 `packages/core/src/services/jobs.ts`：`ctx.jobs`（JobId 品牌 + 原子 start + owner 授权 + onJobDone/onJobsChanged + attachController）
- `jobs-local` 实现（对齐现有 background/cron）
- 现有 `background/cron/notifier` 收敛/桥接到 seam

**成本**：3–4 天

---

## ⚪ 工程化/技术债（长期质量）

### 10. core 导出面梳理

**问题**

`core/index.ts` 309 行 + 30+ 子路径导出，部分子路径是"内部实现泄漏"（如 `./system/database`、`./session/manager`）。harness 有规范化的公共导出面。

**建议**

- 审查哪些导出应保留为公共 API，哪些应收敛
- 减少"内部实现泄漏"到公共导出面

**成本**：1–2 天

---

### 11. 端到端/快照测试补强

**问题**

Mira 795 测试通过，但都是纯单测。harness 有 **keyless 快照测试**（真实可运行示例回放），Mira 缺端到端/快照层。

**建议**

- 为 Agent 循环/工具链路补端到端集成测试
- 考虑引入 keyless 快照回放（真实 transcript 对比）

**成本**：2–4 天

---

### 12. 死代码清理

**问题**

AGENTS.md 记录的未接入 Agent 循环模块：
- `llm/provider-chain.ts` + `provider-policy.ts`（真正的故障转移走 `orchestrate/failover.ts`）
- `agent/fork-cache.ts`（分支缓存）
- `agent/system-context.ts`（系统级上下文）
- `agent/run-coordinator.ts`、`system/tool-scope.ts`（仅测试使用）

**建议**

- 逐个确认保留（作为 API/测试用）还是删除（减少维护面）
- 保留的加注释标注"未接入，保留用途"

**成本**：1–2 天

---

### 13. 子系统文档

**问题**

AGENTS.md 已详尽，但缺 harness 那种子系统级文档（40+ 页）。

**建议**

- 按需补充关键子系统文档（Agent 循环、capability seam、session 事件、权限系统）
- 可缓，按维护需求决定

**成本**：按需

---

## 建议的实施批次

> 不建议一次全做。按价值/风险分批，每批完成即验证（typecheck + test + 手动）再进下一批。

| 批次 | 内容 | 风险 | 工期 |
|------|------|------|------|
| **批次 1（低风险）** | #1 Branded + #2 invariants + #12 死代码清理 | 低 | 3–5 天 |
| **批次 2（架构）** | #3 Agent 接口 + #4 审批审计 + #6 commands | 中 | 1–2 周 |
| **批次 3（功能）** | #7 spill + #8 session-ref + #9 jobs | 低-中 | 1–2 周 |
| **批次 4（安全，独立）** | #5 sandbox（策略 + Windows 后端） | 高 | 1–2 周（独立排期） |
| **批次 5（工程化，可缓）** | #10 导出面 + #11 集成测试 + #13 文档 | 低-中 | 按需 |

---

## 时间估算汇总

| 场景 | 工期 |
|------|------|
| 只做批次 1 | 3–5 天 |
| 批次 1 + 2 | 1.5–2.5 周 |
| 批次 1 + 2 + 3 | 2.5–4.5 周 |
| 全部（含批次 4 Windows 沙箱） | 1.5–3 个月 |

**风险调整因素**
- 批次 4（Windows ACL 沙箱）可单独波动 ±1 周（FFI/权限调试不可预测）
- 多平台验证（Win/mac/Linux）每平台 +0.5–1 周
- Electron 桌面端需持续回归，+20% 时间
