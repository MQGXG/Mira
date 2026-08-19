# Agent 循环核心增强设计

## 目标

将 learn-claude-code 的 s01(循环核心)、s03(权限)、s04(钩子系统)、s05(TodoWrite) 集成到 OmniAgent。

## 架构变更

### 1. Hook 系统 (`app/core/hooks.py` 新增)

4 个事件点，每个支持多个异步回调：

| 事件 | 触发时机 | 回调签名 | 返回非 None 含义 |
|------|---------|---------|----------------|
| `UserPromptSubmit` | 用户输入后、LLM 前 | `async (query: str) → str\|None` | 修改后的 query |
| `PreToolUse` | 工具执行前 | `async (block: ToolCallInfo) → str\|None` | 阻止执行并返回错误 |
| `PostToolUse` | 工具执行后 | `async (block, output) → None` | 仅副作用 |
| `Stop` | 循环退出前 | `async (messages) → str\|None` | 非 None 则强制续跑 |

### 2. 权限系统 (`app/core/permission.py` 新增)

作为 PreToolUse 钩子实现的三道闸门：

- **闸门 1（硬拒绝）**：`DENY_LIST` 命中直接返回错误
- **闸门 2（规则匹配）**：`PERMISSION_RULES` 命中触发闸门 3
- **闸门 3（用户审批）**：通过 SSE 事件 `permission_request` 推前端弹窗

### 3. TodoWrite (`app/tools/todo_write.py` 新增)

- 新的工具 `todo_write`，接收 `[{content, status}]`
- 系统提示词注入当前 TODOs 上下文
- 3 轮未更新自动注入 reminder

### 4. Agent 循环增强 (`app/core/agent.py` 修改)

- `stop_reason` → `has_tool_use` 内容检测
- 集成 Hook 管线
- 集成权限检查
- max_tokens 截断检测
