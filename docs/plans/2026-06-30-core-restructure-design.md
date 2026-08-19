# core 包重构设计方案

## 现状

core 包根目录 47 个 .ts 文件平铺 + 13 个目录 = 60 个 entry。
`agent.ts` 618 行，30 个 import，与 `agent/` 目录并存（重构半成品）。
`tools/` 33 个文件无分类平铺。
`index.ts` 98 行导出混乱（批量导出与逐行导出混用）。
`llm-sdk.ts` 向后兼容层（新旧并存）。
多个单文件空壳目录（`plugin/`、`mcp/`、`workflow/`）。
`layers.ts` 引入 Effect 框架但无人消费。

## 目标

- 根目录 .ts 文件从 47 降至 ~5
- tools 按分类归入 7 个子目录
- agent.ts 拆入 `agent/` 目录，agent/ 目录作为 agent 模块唯一位置
- 删除 `llm-sdk.ts`，统一走 `llm/` 层
- 删除空壳目录和废弃文件
- `index.ts` 从 98 行压缩至 ~30 行统一导出

## 目录结构（目标态）

```
core/src/
├── index.ts                # 统一导出
├── types.ts                # 核心类型
│
├── agent/                  # Agent 循环
│   ├── agent.ts            # ← agent.ts（根）
│   ├── state-machine.ts    # (已有)
│   ├── turn-processor.ts   # (已有)
│   ├── turn.ts             # (已有)
│   ├── context.ts          # (已有)
│   ├── pipeline.ts         # (已有)
│   ├── max-mode.ts         # (已有)
│   ├── utils.ts            # (已有)
│   ├── registry.ts         # (已有)
│   ├── fork-cache.ts       # (已有)
│   ├── system-context.ts   # (已有)
│   └── text-ngram.ts       # (已有)
│
├── llm/                    # 保留不动
│
├── tools/                  # 工具按元分类分目录
│   ├── index.ts            # 统一导出
│   ├── core/               # read, write, edit, list, grep, glob, git, bash-security, create-docx, search-history, code-search
│   ├── knowledge/          # web-search, web-browse, web-fetch, data-analysis, memory
│   ├── execution/          # bash, code-exec, image-gen
│   ├── orchestrate/        # delegate-task, team-tool, task-tool, cron-tool, workflow-tool, worktree-tool, agent-tools
│   ├── interaction/        # question
│   ├── infra/              # lsp-tool
│   └── shared/             # tool-meta, tool-loader, tool-output-store
│
├── session/                # 会话管理
│   ├── manager.ts          # ← session-manager.ts
│   ├── store.ts            # ← session-store.ts
│   ├── context.ts          # ← context-manager.ts
│   ├── compaction.ts       # ← compaction.ts
│   ├── fork.ts             # ← session-fork.ts
│   └── snapshot.ts         # ← snapshot.ts
│
├── config/                 # 配置系统
│   ├── index.ts            # ← config.ts
│   ├── modes.ts            # ← modes.ts
│   ├── profile.ts          # ← agent-profile.ts
│   ├── flags.ts            # ← feature-flags.ts
│   └── paths.ts            # ← platform-paths.ts
│
├── system/                 # 系统基础设施
│   ├── database.ts         # ← database.ts
│   ├── logger.ts           # ← logger.ts
│   ├── registry.ts         # ← registry.ts
│   ├── registry-init.ts    # ← registry-init.ts
│   ├── permission/         # ← permission.ts + permission-gate.ts + permission-store.ts + approval-store.ts
│   ├── server/             # ← server/ + server-manager.ts
│   └── instruction.ts      # ← instruction-context.ts
│
├── orchestrate/            # 编排模块
│   ├── delegate.ts         # ← delegate-runner.ts
│   ├── subagent.ts         # ← subagent-manager.ts
│   ├── team-bus.ts         # ← team-bus.ts
│   ├── dream.ts            # ← dream-distill.ts
│   ├── goal-judge.ts       # ← goal-judge.ts
│   ├── goal-manager.ts     # ← goal-manager.ts
│   ├── failover.ts         # ← failover.ts
│   └── execution.ts        # ← execution/orchestrator.ts
│
├── task/                   # 任务系统
│   ├── planner.ts          # ← task-planner.ts
│   ├── tracker.ts          # ← task-tracker.ts
│   └── budget.ts           # ← iteration-budget.ts
│
├── background/             # 后台任务
│   ├── index.ts            # ← background.ts
│   ├── cron.ts             # ← cron-scheduler.ts
│   ├── worktree.ts         # ← worktree-manager.ts
│   └── recovery.ts         # ← recovery.ts
│
├── shared/                 # 核心工具
│   ├── tool.ts             # ← tool.ts
│   ├── tool-effect.ts      # ← tool-effect.ts
│   ├── tool-executor.ts    # ← tool-executor.ts
│   ├── message-utils.ts    # ← message-utils.ts
│   ├── zod-converter.ts    # ← zod-converter.ts
│   ├── hooks-setup.ts      # ← hooks-setup.ts
│   └── plugin-hooks.ts     # ← plugin-hooks.ts
│
├── memory/                 # 保留不动
├── skill/                  # 保留不动
├── lsp/                    # 保留不动
├── mcp/                    # 降级为文件 mcp.ts
├── workflow/               # 降级为文件 workflow.ts
├── plugin/                 # 降级为文件 plugin.ts
│
├── compose-mode.ts         # 保留在根（独立文件）
└── layers.ts               # 删除（无人消费）
```

## 分阶段迁移计划

### Phase 0：清理无风险项（Day 1）

| 操作 | 涉及文件 |
|---|---|
| 删除 layers.ts | `core/src/layers.ts` |
| 确认 mcp/、workflow/、plugin/ 目录内容 | 若仅 index.ts，降级为单文件 |
| 确认 compose-mode.ts、types.ts 留在根目录 | 无需移动 |

### Phase 1：低频模块搬家（Day 2-3）

1. `system/` — database, logger, registry, permission, server, instruction
2. `shared/` — tool, tool-effect, tool-executor, message-utils, zod-converter, hooks-setup, plugin-hooks
3. `task/` — planner, tracker, budget
4. `background/` — background, cron, worktree, recovery

策略：每个子目录完成后执行 `pnpm typecheck` 验证。

### Phase 2：中频模块搬家（Day 4-6）

1. `session/` — manager, store, context, compaction, fork, snapshot
2. `config/` — config, modes, profile, flags, paths
3. `orchestrate/` — delegate, subagent, team-bus, dream, goal-judge, goal-manager, failover, execution

⚠️ session 内部互相引用多，建议一批次搬入。

### Phase 3：tools 分类（Day 7-9）

33 个文件按 category 搬入 7 个子目录。纯机械搬运，最繁琐但逻辑最简单。

### Phase 4：高风险操作（Day 10-12）

1. agent.ts → agent/agent.ts + 更新 30 条 import 路径
2. 删除 llm-sdk.ts，turn-processor 改为直接引用 llm/route
3. 清理 index.ts 导出

### Phase 5：验证（Day 13-14）

```bash
pnpm typecheck
pnpm test
pnpm lint
# 手动验证核心 Agent 流程
```

## 风险管控

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| agent.ts import 路径大面积失效 | 高 | Phase 4 最后做，前面稳定后再动 |
| tools 互相引用路径错误 | 中 | 每搬一个子目录 typecheck |
| llm-sdk.ts 有隐藏引用 | 中 | 删除前全局 grep 确认 |
| electron/ui 引用旧路径 | 中 | 全部改完后构建 electron 验证 |
| git blame 丢失历史 | 低 | `git mv` 而非 copy+delete |

## 验收标准

- [ ] `pnpm typecheck` 0 error
- [ ] `pnpm test` 全部通过
- [ ] `pnpm lint` 0 error
- [ ] 根目录 .ts 文件 ≤ 5 个
- [ ] `index.ts` 导出行 ≤ 40 行
- [ ] `tools/` 无平铺文件
- [ ] `agent.ts` 移入 `agent/` 目录
- [ ] `llm-sdk.ts` 已删除
