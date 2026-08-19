# learn-claude-code 课程与 Mira 实现对照

## 对照表

| 课程 | 机制 | Mira 实现 | 状态 |
|------|------|-----------|------|
| **s01** | Agent Loop | `packages/core/src/agent.ts` — `Agent.run()` 循环 | ✅ 已增强 |
| **s02** | Tool Use | `packages/core/src/registry.ts` — 工具注册 + Zod Schema | ✅ 已完成 |
| **s03** | Permission | `packages/core/src/permission.ts` — 通配符匹配 + 硬拒绝 | ✅ 已完成 |
| **s04** | Hooks | `packages/core/src/hooks-setup.ts` — Hook 系统 | ✅ 已完成 |
| **s05** | TodoWrite | `packages/core/src/task-planner.ts` — 任务规划 | ✅ 已完成 |
| **s06** | Subagent | `packages/core/src/subagent-manager.ts` — 子 Agent 管理（最大并行 5） | ✅ 已完成 |
| **s07** | Skill Loading | `packages/core/src/skill/` — Skill 系统（Slash 命令 + 动态加载） | ✅ 已完成 |
| **s08** | Context Compact | `packages/core/src/compaction.ts` + `context-manager.ts` — 上下文压缩 + checkpoint/rebuild | ✅ 已完成 |
| **s09** | Memory | `packages/core/src/memory/` — 四层记忆系统（checkpoint/builtin/fts/file/vector） | ✅ 已完成 |
| **s10** | System Prompt | `packages/core/src/agent/context.ts` — 系统提示构建 + 记忆注入 | ✅ 已完成 |
| **s11** | Error Recovery | `packages/core/src/recovery.ts` + `failover.ts` — 错误恢复 + LLM 故障转移 | ✅ 已完成 |
| **s12** | Task System | `packages/core/src/task-tracker.ts` + `task-planner.ts` — 任务追踪 + 规划 | ✅ 已完成 |
| **s13** | Background Tasks | `packages/core/src/background.ts` — 后台任务 | ✅ 已完成 |
| **s14** | Cron Scheduler | `packages/core/src/cron-scheduler.ts` — 定时调度 | ✅ 已完成 |
| **s15** | Agent Teams | `packages/core/src/team-bus.ts` — 团队通信总线 | ✅ 已完成 |
| **s16** | Team Protocols | `packages/core/src/team-bus.ts` — 协议状态 + 审批 | ✅ 已完成 |
| **s17** | Autonomous Agents | `packages/core/src/subagent-manager.ts` — 子 Agent 自治 | ✅ 已完成 |
| **s18** | Worktree Isolation | `packages/core/src/worktree-manager.ts` — Git Worktree 管理 | ✅ 已完成 |
| **s19** | MCP Plugin | `packages/core/src/mcp/` — Model Context Protocol 支持 | ✅ 已完成 |
| **s20** | Comprehensive | 全部机制已集成到 Agent.run() 循环 | ✅ 已完成 |

## 额外实现

| 机制 | Mira 实现 | 说明 |
|------|-----------|------|
| **LSP** | `packages/core/src/lsp/` | 代码智能（定义跳转/引用查找/Hover） |
| **Goal Judge** | `packages/core/src/goal-judge.ts` | 独立验证者判断任务完成度 |
| **Max Mode** | `packages/core/src/agent/max-mode.ts` | 并行采样选优 |
| **Dream/Distill** | `packages/core/src/dream-distill.ts` | 记忆进化（知识提取/工作流发现） |
| **Dynamic Workflow** | `packages/core/src/workflow/` | 代码级编排（agent/parallel/pipeline） |
| **Gemini 协议** | `packages/core/src/llm/protocols/gemini.ts` | Google Gemini 协议适配 |

## 实现深度评估

### 完整实现 (✅) — 20 项

s01·s02·s03·s04·s05·s06·s07·s08·s09·s10·s11·s12·s13·s14·s15·s16·s17·s18·s19·s20

### 额外实现 — 6 项

LSP · Goal Judge · Max Mode · Dream/Distill · Dynamic Workflow · Gemini 协议

## 未实现 (❌) — 0 项

所有课程机制均已实现。

## 架构变化

从 Python (FastAPI) 迁移到全 TypeScript：
- `app/core/agent.py` → `packages/core/src/agent.ts`
- `app/tools/` → `packages/core/src/tools/`
- `app/core/permission.py` → `packages/core/src/permission.ts`
- HTTP/SSE 通信 → Electron IPC (contextBridge)
- ChromaDB → Transformers.js 本地 ONNX 推理
