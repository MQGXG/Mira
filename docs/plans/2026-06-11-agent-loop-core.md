# Agent Loop Core 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Hook 系统、权限系统、TodoWrite 集成到 OmniAgent 的 Agent 循环核心

**Architecture:** 以 `app/core/hooks.py` 作为事件总线，权限系统作为 PreToolUse 钩子接入，TodoWrite 作为标准工具注册；Agent.run() 集成完整管线：UserPromptSubmit → LLM → PreToolUse(含权限) → 执行 → PostToolUse → Stop

**Tech Stack:** Python 3.10+ / FastAPI / asyncio

---

### Task 1: Hook 系统 (`app/core/hooks.py`)

**Files:**
- Create: `agent-backend/app/core/hooks.py`

**Step 1: 创建 Hook 系统**

```python
"""Hook 事件系统"""

from typing import Any, Callable, Coroutine

HookCallback = Callable[..., Coroutine[Any, Any, str | None]]


class Hooks:
    """事件总线：注册和触发钩子"""

    def __init__(self):
        self._hooks: dict[str, list[HookCallback]] = {
            "UserPromptSubmit": [],
            "PreToolUse": [],
            "PostToolUse": [],
            "Stop": [],
        }

    def register(self, event: str, callback: HookCallback):
        self._hooks[event].append(callback)

    async def trigger(self, event: str, *args) -> str | None:
        for cb in self._hooks[event]:
            result = await cb(*args)
            if result is not None:
                return result
        return None


hooks = Hooks()
```

**Step 2: 验证文件创建成功**

Run: `python -c "import ast; ast.parse(open('agent-backend/app/core/hooks.py').read()); print('OK')"`
Expected: `OK`

---

### Task 2: 权限系统 (`app/core/permission.py`)

**Files:**
- Create: `agent-backend/app/core/permission.py`

**Step 1: 创建权限系统**

三道闸门：
- Gate 1: 硬拒绝列表
- Gate 2: 规则匹配
- Gate 3: 用户审批（通过 SSE 事件 `permission_request`）

```python
"""三道闸门权限系统"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Gate 1: 硬拒绝列表
DENY_LIST = [
    "rm -rf /", "sudo", "shutdown", "reboot",
    "mkfs", "dd if=", "> /dev/sda",
]

# Gate 2: 权限规则
PERMISSION_RULES = [
    {
        "tools": ["write_file", "edit_file"],
        "check": lambda args: "../" in args.get("path", ""),
        "message": "写入工作区外",
    },
    {
        "tools": ["bash"],
        "check": lambda args: any(kw in args.get("command", "") for kw in ["rm ", "> /etc/", "chmod 777"]),
        "message": "潜在破坏性命令",
    },
]


def check_deny_list(command: str) -> str | None:
    for pattern in DENY_LIST:
        if pattern in command:
            return f"被拒绝: '{pattern}' 在硬拒绝列表中"
    return None


def check_rules(tool_name: str, args: dict) -> str | None:
    for rule in PERMISSION_RULES:
        if tool_name in rule["tools"] and rule["check"](args):
            return rule["message"]
    return None


def need_user_approval(tool_name: str, args: dict) -> str | None:
    """返回需要审批的原因，None 表示不需要"""
    if tool_name == "bash":
        reason = check_deny_list(args.get("command", ""))
        if reason:
            return reason
    reason = check_rules(tool_name, args)
    return reason
```

**Step 2: 验证**

Run: `python -c "from app.core.permission import need_user_approval; print('OK')"`
Expected: `OK`

---

### Task 3: TodoWrite 工具 (`app/tools/todo_write.py`)

**Files:**
- Create: `agent-backend/app/tools/todo_write.py`

**Step 1: 创建 TodoWrite 工具**

```python
"""TodoWrite 工具 — 计划管理"""

import json
import logging
from app.tools.base import BaseTool, ToolParam, ToolResult

logger = logging.getLogger(__name__)

CURRENT_TODOS: list[dict] = []


class TodoWriteTool(BaseTool):
    @property
    def name(self) -> str:
        return "todo_write"

    @property
    def description(self) -> str:
        return "创建和管理当前编码会话的任务列表。在开始多步骤任务前先用此工具列出步骤。"

    @property
    def parameters(self) -> list[ToolParam]:
        return [
            ToolParam(name="todos", type="array",
                      description="任务列表，每项含 content 和 status(pending/in_progress/completed)"),
        ]

    async def execute(self, **kwargs) -> ToolResult:
        global CURRENT_TODOS
        todos = kwargs.get("todos", [])
        if isinstance(todos, str):
            try:
                todos = json.loads(todos)
            except json.JSONDecodeError:
                return ToolResult(success=False, output="", error="todos 必须是 JSON 数组")
        if not isinstance(todos, list):
            return ToolResult(success=False, output="", error="todos 必须是数组")
        for t in todos:
            if not isinstance(t, dict) or "content" not in t or "status" not in t:
                return ToolResult(success=False, output="", error="每项必须含 content 和 status")
            if t["status"] not in ("pending", "in_progress", "completed"):
                return ToolResult(success=False, output="",
                                  error=f"非法状态: {t['status']}")
        CURRENT_TODOS = todos
        status_line = ", ".join(f"{t['content']}[{t['status']}]" for t in todos)
        logger.info(f"[TodoWrite] 更新 {len(todos)} 项: {status_line}")
        return ToolResult(success=True, output=f"已更新 {len(todos)} 个任务")

    def to_openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "content": {"type": "string"},
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "completed"],
                                    },
                                },
                                "required": ["content", "status"],
                            },
                        },
                    },
                    "required": ["todos"],
                },
            },
        }

    def to_claude_schema(self) -> dict:
        s = self.to_openai_schema()
        fn = s["function"]
        return {
            "name": fn["name"],
            "description": fn["description"],
            "input_schema": fn["parameters"],
        }
```

**Step 2: 验证**

Run: `python -c "from app.tools.todo_write import TodoWriteTool; print('OK')"`
Expected: `OK`

---

### Task 4: 注册 TodoWrite 工具 (`app/tools/__init__.py`)

**Files:**
- Modify: `agent-backend/app/tools/__init__.py`

**Step 1: 添加导入和注册**

在第 7 行后添加：
```python
from app.tools.todo_write import TodoWriteTool

tool_registry.register(TodoWriteTool())
```

**Step 2: 验证**

Run: `python -c "from app.tools import tool_registry; assert tool_registry.get('todo_write'); print('OK')"`
Expected: `OK`

---

### Task 5: 事件系统增强 (`app/core/events.py`)

**Files:**
- Modify: `agent-backend/app/core/events.py`

**Step 1: 添加新事件类型**

在 `FinishEvent` 后添加：
```python
@dataclass
class PermissionRequestEvent(LLMEvent):
    """权限审批请求"""
    tool_name: str
    args: dict
    reason: str
    request_id: str
```

在 `StreamEvent` 中添加静态方法：
```python
    @staticmethod
    def permission_request(tool_name: str, args: dict, reason: str, request_id: str) -> "StreamEvent":
        return StreamEvent(type="permission_request", data={
            "tool_name": tool_name,
            "args": args,
            "reason": reason,
            "request_id": request_id,
        })

    @staticmethod
    def permission_result(request_id: str, approved: bool) -> "StreamEvent":
        return StreamEvent(type="permission_result", data={
            "request_id": request_id,
            "approved": approved,
        })
```

---

### Task 6: 增强 Agent 循环 (`app/core/agent.py`)

**Files:**
- Modify: `agent-backend/app/core/agent.py`

**Step 1: 集成 Hook 系统、权限系统、TodoWrite、错误恢复**

核心变更：
1. 导入 hooks / permission / CURRENT_TODOS
2. `run()` 方法集成完整管线
3. 使用 `has_tool_use` 取代 `stop_reason` 作为循环继续信号
4. 集成 TodoWrite reminder
5. 集成权限检查作为 PreToolUse 钩子
6. 添加 `max_tokens` 恢复

关键代码修改：

```python
# 新增导入
from app.core.hooks import hooks
from app.core.permission import need_user_approval
from app.tools.todo_write import CURRENT_TODOS

# Agent.__init__ 添加 todo_rounds 计数器
self.todo_rounds_since_update = 0

# _build_system_prompt 添加 TODOs 上下文
def _build_system_prompt(self) -> str:
    base = SYSTEM_PROMPT
    suffix = self.config.system_prompt_suffix
    if suffix:
        base = f"{base}\n\n{suffix}"
    # 注入 TODOs
    if CURRENT_TODOS:
        todo_lines = ["\n\n## 当前任务列表"]
        for t in CURRENT_TODOS:
            icon = {"pending": "○", "in_progress": "▸", "completed": "✓"}[t["status"]]
            todo_lines.append(f"{icon} {t['content']} [{t['status']}]")
        base += "\n".join(todo_lines)
    return base

# run() 方法中集成管线
async def run(self, user_message, history=None):
    # UserPromptSubmit hook
    modified = await hooks.trigger("UserPromptSubmit", user_message)
    final_message = modified or user_message
    
    messages = [...]
    
    for iteration in range(max_iter):
        # Todo remind
        if self.todo_rounds_since_update >= 3 and messages:
            messages.append({"role": "user", "content": "<提醒>请更新你的任务列表。</提醒>"})
            self.todo_rounds_since_update = 0
        
        # LLM call
        async for event in self.llm.chat_stream(messages, tools=tools):
            # ... 收集 ...
        
        # has_tool_use 检查
        if not pending_tool_calls:
            yield StreamEvent.finish(finish_reason or "stop")
            await hooks.trigger("Stop", messages)
            return
        
        # PreToolUse hook (含权限)
        for tc in pending_tool_calls:
            blocked = await hooks.trigger("PreToolUse", tc)
            if blocked:
                # 权限拒绝
                ...
                continue
            
            # 权限闸门
            reason = need_user_approval(tc["name"], args)
            if reason:
                yield StreamEvent.permission_request(...)
                # 等待前端审批（简化：先拒绝）
                ...
            
            # 执行工具
            result = await self.tools.execute(name, args)
            
            # PostToolUse hook
            await hooks.trigger("PostToolUse", tc, result)
            
            # TodoWrite 检测
            if name == "todo_write":
                self.todo_rounds_since_update = 0
            else:
                self.todo_rounds_since_update += 1
```

**Step 2: 验证语法**

Run: `python -c "import ast; ast.parse(open('agent-backend/app/core/agent.py').read()); print('OK')"`
Expected: `OK`

---

### Task 7: 注册默认钩子

**Files:**
- Create: `agent-backend/app/core/hooks_setup.py`

**Step 1: 创建默认钩子注册**

```python
"""默认钩子注册"""

import logging
from app.core.hooks import hooks
from app.core.permission import need_user_approval

logger = logging.getLogger(__name__)


async def log_user_prompt(query: str) -> None:
    logger.info(f"[Hook] 用户输入: {query[:100]}")


async def permission_check(block) -> str | None:
    """PreToolUse: 权限闸门"""
    if block.get("type") != "function":
        return None
    name = block.get("name", "")
    args = block.get("arguments", {})
    reason = need_user_approval(name, args)
    return reason  # None=通过, str=需要审批


async def log_tool_call(block) -> None:
    name = block.get("name", "")
    logger.info(f"[Hook] 工具调用: {name}")


async def log_tool_result(block, result) -> None:
    name = block.get("name", "")
    logger.info(f"[Hook] 工具完成: {name}")


async def log_stop(messages: list) -> None:
    logger.info(f"[Hook] 循环结束, 消息数: {len(messages)}")


def setup_default_hooks():
    hooks.register("UserPromptSubmit", log_user_prompt)
    hooks.register("PreToolUse", permission_check)
    hooks.register("PreToolUse", log_tool_call)
    hooks.register("PostToolUse", log_tool_result)
    hooks.register("Stop", log_stop)
```

**Step 2: 在主模块中调用 setup**

Modify `agent-backend/app/main.py`:
在 `lifespan` 的 startup 部分添加:
```python
from app.core.hooks_setup import setup_default_hooks
setup_default_hooks()
```

---

### Task 8: 系统提示词更新 (`app/prompts/system.py`)

**Files:**
- Modify: `agent-backend/app/prompts/system.py`

**Step 1: 添加计划引导**

添加 todo_write 工具描述和使用引导：

```python
SYSTEM_PROMPT = """你是 OmniAgent，一个全能 AI 助手。

...

工作原则：
1. 先思考再行动，制定计划后逐步执行
2. 遇到不确定的信息，主动搜索验证
3. 需要计算时用代码，不要心算
4. 复杂任务拆解为多个步骤，使用 todo_write 列出步骤
5. 每步执行后汇报进展并更新 todo 状态"""
```

---

### Task 9: 验证集成

Run: `python -c "from app.core.agent import Agent; from app.core.hooks import hooks; from app.core.permission import need_user_approval; from app.tools.todo_write import TodoWriteTool; print('All imports OK')"`
Expected: `All imports OK`
