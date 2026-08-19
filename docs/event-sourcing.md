# 事件溯源（Event Sourcing）

> 参考 DeepSeek Harness 的 "Model-visible means logged" 原则与 `…Map → derived-union` 类型模式落地。

## 核心原则

**事件为唯一事实源，`messages` 表降级为投影缓存。**

- 所有会话消息变化都通过追加 `session_events` 表事件记录（append-only）
- `messages` 表是事件的**投影缓存**，可从事件流任意时刻完整重建
- 消息身份 = 事件 `seq`（逻辑 id），缓存表物理 `id` 由自增主键分配（两者解耦）

## 模块职责

| 文件 | 职责 |
|------|------|
| `session/event-types.ts` | 事件类型映射 `SessionEventMap` + 判别联合 `SessionEvent` + 工厂函数 |
| `session/event-store.ts` | 事件追加/读取/快照（`session_events` 表） |
| `session/projector.ts` | 事件流 → 消息列表投影（快照 + 增量） |
| `session/store.ts` | 写路径（事件 + 投影缓存同步）、读路径（事件重建 + 回写缓存）、删除 |

## 数据流

### 写入（`appendMessage`）
1. `EventStore.append(createMessageEvent(...))` — 追加事件（唯一事实源）
2. 同步更新 `messages` 投影缓存 + FTS5 索引 + 会话标题

### 读取（`loadSession`）
1. 有事件（`latestSeq > 0`）：`getLatestSnapshot()` + `getEvents(afterSeq)` → `Projector.projectFromSnapshot()` 重建，回写投影缓存
2. 无事件（历史数据）：回退读 `messages` 缓存表

### 删除（`deleteMessage`）
1. `EventStore.append(createMessageDeletedEvent(...))` — 追加删除事件
2. 从事件流重建投影缓存（反映删除后的状态）

## 类型模式：SessionEventMap

插件可通过 **declaration merging** 声明新事件类型，无需修改 core：

```ts
declare module "@mira/core" {
  interface SessionEventMap {
    "skill.invoked": { skillName: string; durationMs: number }
  }
}
```

- `EventType = keyof SessionEventMap` 自动包含新类型
- `SessionEvent` 是判别联合，`switch (event.type)` 自动收窄 `payload`

## 快照（Snapshot）

- `saveSnapshot` 保存某 `up_to_seq` 时刻的消息列表 JSON，避免每次全量回放
- `loadSession` 优先用"最新快照 + 增量事件"重建
- `deleteSession` 会同步清理 `session_events` / `event_snapshots` / `messages`

## 压缩（Compaction）

- `reactiveCompact` 触发压缩后追加 `session.compacted` 事件（log-only，可追溯）
- 该事件**不参与消息投影**——压缩不丢失原始消息历史，仅记录发生了什么
- **收益校验**：压缩结果必须比原内容更小（token 级，由 `shared/token-meter.ts` 结构感知估算），否则放弃压缩
- **工具配对平衡**：`session/tool-pairing.ts` 保证压缩切口不切断 tool-call/result 对（`snipCompact` 的头/尾切口调整到平衡边界，无法平衡切分时保守不压缩）

## 兼容性

- 历史会话（无事件）自动回退读 `messages` 缓存表，无需迁移
- 对外 API（`appendMessage` / `loadSession` / `deleteMessage` / `messageCount`）签名不变
