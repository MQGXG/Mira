# learn-claude-code 精华参考

> 来源: https://github.com/shareAI-lab/learn-claude-code
>
> 核心理念: **Agency（智能）来自模型训练，不是来自代码编排。**
> Agent = Model (LLM) + Harness（运行环境）

---

## 一、核心模式（贯穿始终）

```python
def agent_loop(messages):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages, tools=TOOLS
        )
        messages.append({"role": "assistant", "content": response.content})

        if not has_tool_use(response.content):
            return

        for block in response.content:
            if block.type == "tool_use":
                output = TOOL_HANDLERS[block.name](**block.input)
                messages.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })
```

**关键点：**
- 循环从不改变，改变的是 tools、hooks、permissions 等外围机制
- 用 `has_tool_use`（检查实际 content 中的 tool_use block）而非 `stop_reason`（流式中不可靠）
- 每个 `tool_use` block 对应一个 `tool_result`

---

## 二、20 章机制速查

| # | 机制 | 一句话 | 关键代码 |
|---|------|--------|---------|
| s01 | Agent Loop | `while True` + bash 一个工具 = 一个 Agent | `stop_reason == "tool_use"` 判断循环继续 |
| s02 | Tool Dispatch | 加工具 = TOOLS 加一条 + TOOL_HANDLERS 加一行 | `handler = TOOL_HANDLERS[block.name]; output = handler(**block.input)` |
| s03 | Permission | 三道闸门串在工具执行前 | `check_deny_list → check_rules → ask_user` |
| s04 | Hooks | 4 个事件点，扩展挂在钩子上不写进循环 | `register_hook("PreToolUse", fn); trigger_hooks("PreToolUse", block)` |
| s05 | TodoWrite | 先列步骤再动手，3 轮不更新自动提醒 | `todo_write([{content, status}])` + `rounds_since_todo >= 3` 注入 reminder |
| s06 | Subagent | 全新 messages[]，只回传结论 | `spawn_subagent(description)` → fresh `messages = [{"role":"user", "content":description}]` |
| s07 | Skill | 目录注入 SYSTEM(~100t)，内容按需加载(~2000t) | `list_skills()` 在 SYSTEM 中；`load_skill(name)` 通过 tool_result 注入 |
| s08 | Compact | 4 层：budget→snip→micro→auto，便宜的先跑 | `tool_result_budget → snip_compact → micro_compact → compact_history` |
| s09 | Memory | `.md` 文件 + MEMORY.md 索引，LLM side-query 选记忆 | `select_relevant_memories()` 用 Sonnet 选, `extract_memories()` 每轮后提取 |
| s10 | Prompt | 分节拼接 + json.dumps 缓存 | `PROMPT_SECTIONS["identity"] + assemble_system_prompt(context)` |
| s11 | Recovery | 3 种恢复：升级 max_tokens / reactive compact / 退避 | `with_retry(fn)` 包 LLM 调用, `max_tokens` 先升级再续写 |
| s12 | Task | `.tasks/{id}.json` + blockedBy 依赖图 | `can_start()` 检查所有依赖完成; `claim_task()` → `complete_task()` |
| s13 | Background | daemon 线程跑慢操作，完成通知注入 | `should_run_background()` → daemon thread → `<task_notification>` |
| s14 | Cron | 独立线程 1s 轮询 + queue processor 自动交付 | `cron_matches()` 五段式匹配; durable 持久化到 `.scheduled_tasks.json` |
| s15 | Teams | 文件收件箱 + 队友线程 + inbox 注入 | `MessageBus.send/read_inbox` → Lead 主循环末尾 `consume_lead_inbox()` |
| s16 | Protocols | request_id 关联请求/响应，类型校验 | `ProtocolState` + `match_response()` 校验 response_type |
| s17 | Autonomous | WORK→IDLE→SHUTDOWN 三阶段，自动认领 | `idle_poll()` 每 5s 轮询; `scan_unclaimed_tasks()` → `claim_task()` |
| s18 | Worktree | git worktree 隔离 + 任务绑定 + cwd 切换 | `create_worktree(name, task_id)`; 队友 bash/read/write 自动在 worktree 下执行 |
| s19 | MCP | 标准协议发现工具，`mcp__server__tool` 命名 | `assemble_tool_pool()` 组装内置 + MCP; `normalize_mcp_name()` 防注入 |
| s20 | Comprehensive | 全部 19 章机制归一到 2123 行代码 | 同一个 `while True`，周围 harness 完整 |

---

## 三、Hook 系统（s04 核心）

```python
HOOKS = {"UserPromptSubmit": [], "PreToolUse": [], "PostToolUse": [], "Stop": []}

def register_hook(event: str, callback):
    HOOKS[event].append(callback)

def trigger_hooks(event: str, *args):
    for callback in HOOKS[event]:
        result = callback(*args)
        if result is not None:
            return result
    return None
```

4 个事件点的触发时机：

```
用户输入 → UserPromptSubmit → LLM → PreToolUse → 工具执行 → PostToolUse → 循环
                              ↑                                         |
                              └────────────── Stop ←────────────────────┘
```

**典型用途：**
- `UserPromptSubmit`: 输入验证、上下文注入
- `PreToolUse`: 权限检查、日志记录 ← **这里挂权限系统**
- `PostToolUse`: 大输出告警、自动 git add
- `Stop`: 统计、清理、强制续跑（返回非 None 时）

---

## 四、权限系统（s03 核心）

```python
# Gate 1: 硬拒绝
DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="]

def check_deny_list(command: str) -> str | None:
    for pattern in DENY_LIST:
        if pattern in command:
            return f"Blocked: '{pattern}'"

# Gate 2: 规则匹配
PERMISSION_RULES = [
    {"tools": ["write_file", "edit_file"],
     "check": lambda args: not is_inside_workspace(args.get("path", "")),
     "message": "Writing outside workspace"},
    {"tools": ["bash"],
     "check": lambda args: is_destructive(args.get("command", "")),
     "message": "Destructive command"},
]

def check_rules(tool_name: str, args: dict) -> str | None:
    for rule in PERMISSION_RULES:
        if tool_name in rule["tools"] and rule["check"](args):
            return rule["message"]
    return None

# Gate 3: 用户审批
def ask_user(tool_name: str, args: dict, reason: str) -> bool:
    print(f"⚠ {reason}")
    print(f"   Tool: {tool_name}({args})")
    return input("Allow? [y/N] ").strip().lower() in ("y", "yes")

# 管线串起来
def check_permission(block) -> bool:
    if block.name == "bash":
        reason = check_deny_list(block.input.get("command", ""))
        if reason:
            return False  # Gate 1 拦截
    reason = check_rules(block.name, block.input)
    if reason:
        return ask_user(block.name, block.input, reason)  # Gate 2+3
    return True  # 全部通过
```

**接入循环：** 在 `PreToolUse` hook 中调用 `check_permission()`，返回非 None 时阻止执行。

---

## 五、上下文压缩管线（s08 核心）

顺序不能换: **budget → snip → micro → auto**

```
messages[]
  ↓
L3 tool_result_budget  ── 大结果落盘到 .task_outputs/tool-results/
  ↓
L1 snip_compact         ── 消息数 > 50 时裁中间，保头 3 + 尾 47，不拆 tool_use/tool_result 对
  ↓
L2 micro_compact        ── 只保留最近 3 条 tool_result 完整内容，旧的替换为占位符
  ↓
  [token > 阈值?]
  ├─ No  → LLM
  └─ Yes → L4 compact_history ── LLM 全量摘要 + 保存 transcript
                ↓
         prompt_too_long? → reactive_compact（更激进，保尾 5 条）
```

**关键函数：**

```python
# L1: 裁中间消息
def snip_compact(messages, max_messages=50):
    if len(messages) <= max_messages:
        return messages
    head_end, tail_start = 3, len(messages) - (max_messages - 3)
    # 保护：不拆 tool_use/tool_result 对
    if _message_has_tool_use(messages[head_end - 1]):
        while head_end < len(messages) and _is_tool_result_message(messages[head_end]):
            head_end += 1
    if _is_tool_result_message(messages[tail_start]) and _message_has_tool_use(messages[tail_start - 1]):
        tail_start -= 1
    snipped = tail_start - head_end
    placeholder = {"role": "user", "content": f"[snipped {snipped} messages]"}
    return messages[:head_end] + [placeholder] + messages[tail_start:]

# L2: 旧结果占位
def micro_compact(messages):
    tool_results = collect_tool_results(messages)
    if len(tool_results) <= KEEP_RECENT_TOOL_RESULTS:
        return messages
    for _, _, block in tool_results[:-KEEP_RECENT_TOOL_RESULTS]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"
    return messages

# L3: 大结果落盘
def tool_result_budget(messages, max_bytes=200_000):
    last = messages[-1]
    if not last or last.get("role") != "user":
        return messages
    blocks = [(i, b) for i, b in enumerate(last["content"])
              if b.get("type") == "tool_result"]
    total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    if total <= max_bytes:
        return messages
    # 从最大的开始落盘
    for _, block in sorted(blocks, key=lambda p: len(str(p[1].get("content", ""))), reverse=True):
        if total <= max_bytes:
            break
        block["content"] = persist_large_output(block["tool_use_id"], str(block["content"]))
        total = recalculate_total(blocks)
    return messages

# L4: LLM 全量摘要
def compact_history(messages):
    transcript_path = write_transcript(messages)  # 先保存完整对话
    summary = summarize_history(messages)          # LLM 调用
    return [{"role": "user", "content": f"[Compacted]\n\n{summary}"}]

# 应急: API 返回 prompt_too_long 时
def reactive_compact(messages):
    summary = summarize_history(messages)
    tail = messages[-5:]
    return [{"role": "user", "content": f"[Reactive compact]\n\n{summary}"}, *tail]
```

---

## 六、子智能体（s06 核心）

```python
def spawn_subagent(description: str) -> str:
    # 子 Agent 只有基础工具（无 task — 禁止递归）
    sub_tools = [bash, read, write, edit, glob]
    messages = [{"role": "user", "content": description}]  # ⭐ 全新 messages[]

    for _ in range(30):  # 安全限制
        response = client.messages.create(
            model=MODEL, system=SUB_SYSTEM,
            messages=messages, tools=sub_tools, max_tokens=8000,
        )
        messages.append(response)
        if response.stop_reason != "tool_use":
            break
        # ... 执行工具，处理结果 ...

    return extract_text(messages[-1]["content"])  # ⭐ 只回传结论，历史丢弃
```

**关键设计：**
- 全新 `messages[]`：子 Agent 的中间过程不污染主 Agent
- 只回传结论：`extract_text(last_message)`，整个消息历史丢弃
- 禁止递归：子 Agent 没有 `task` 工具
- 安全策略不跳过：子 Agent 工具调用也走 PreToolUse hook

---

## 七、多 Agent 协作（s15-s17 核心）

### 7.1 MessageBus（s15）

```python
class MessageBus:
    def send(self, from_agent, to_agent, content, msg_type="message"):
        msg = {"from": from_agent, "to": to_agent, "content": content,
               "type": msg_type, "ts": time.time()}
        inbox = MAILBOX_DIR / f"{to_agent}.jsonl"
        with open(inbox, "a") as f:
            f.write(json.dumps(msg) + "\n")

    def read_inbox(self, agent):
        inbox = MAILBOX_DIR / f"{agent}.jsonl"
        if not inbox.exists():
            return []
        msgs = [json.loads(line) for line in inbox.read_text().splitlines()]
        inbox.unlink()  # 消费式读取
        return msgs
```

### 7.2 队友生命周期（s17）

```
WORK 阶段:
  inbox → dispatch 协议消息 → LLM → 工具循环
  → stop_reason != tool_use → 进入 IDLE

IDLE 阶段:
  每 5s 轮询 inbox + 任务板
  → shutdown_request? → 回复 → SHUTDOWN
  → 新任务? → claim → 回到 WORK
  → 60s 超时? → SHUTDOWN

SHUTDOWN:
  发 summary 给 Lead → 退出线程
```

### 7.3 协议状态机（s16）

```python
@dataclass
class ProtocolState:
    request_id: str
    type: str           # "shutdown" | "plan_approval"
    sender: str
    target: str
    status: str         # pending → approved | rejected
    payload: str

# 关机握手流程
# ① Lead → BUS.send("shutdown_request", {request_id})
# ② 队友 → dispatch → handle_shutdown_request
# ③ 队友 → BUS.send("shutdown_response", {request_id, approve: True})
# ④ Lead → match_response(request_id) → status = "approved"
```

### 7.4 自治认领（s17）

```python
def scan_unclaimed_tasks() -> list[dict]:
    """找 pending + 无 owner + 依赖已完成的任务"""
    unclaimed = []
    for f in sorted(TASKS_DIR.glob("task_*.json")):
        task = json.loads(f.read_text())
        if (task.get("status") == "pending"
                and not task.get("owner")
                and can_start(task["id"])):
            unclaimed.append(task)
    return unclaimed
```

---

## 八、系统提示词组装（s10 核心）

```python
PROMPT_SECTIONS = {
    "identity": "You are a coding agent. Act, don't explain.",
    "tools": "Available tools: bash, read_file, write_file.",
    "workspace": f"Working directory: {WORKDIR}",
    "memory": "Relevant memories are injected below when available.",
}

def assemble_system_prompt(context: dict) -> str:
    sections = [PROMPT_SECTIONS["identity"],
                PROMPT_SECTIONS["tools"],
                PROMPT_SECTIONS["workspace"]]
    if context.get("memories"):
        sections.append(f"Relevant memories:\n{context['memories']}")
    return "\n\n".join(sections)

# 带缓存的获取
_last_key, _last_prompt = None, None

def get_system_prompt(context: dict) -> str:
    key = json.dumps(context, sort_keys=True)
    if key == _last_key:
        return _last_prompt
    _last_key, _last_prompt = key, assemble_system_prompt(context)
    return _last_prompt
```

---

## 九、错误恢复（s11 核心）

```python
class RecoveryState:
    def __init__(self):
        self.has_escalated = False          # max_tokens 是否已升级
        self.recovery_count = 0             # 续写次数
        self.consecutive_529 = 0            # 连续 529 计数
        self.has_attempted_reactive = False # 是否已做 reactive compact
        self.current_model = PRIMARY_MODEL

# 指数退避
def retry_delay(attempt):
    base = min(500 * (2 ** attempt), 32000) / 1000
    return base + random.uniform(0, base * 0.25)

# 三种恢复路径
# 1. max_tokens: 8K→64K(不追加)→续写(最多3次)
if response.stop_reason == "max_tokens":
    if not state.has_escalated:
        max_tokens = 64000; state.has_escalated = True; continue
    messages.append(CONTINUATION_PROMPT); continue

# 2. prompt_too_long: reactive compact → 重试
except PromptTooLongError:
    messages[:] = reactive_compact(messages); continue

# 3. 429/529: 指数退避 + fallback 模型
def with_retry(fn, state):
    for attempt in range(MAX_RETRIES):
        try: return fn()
        except (RateLimitError, OverloadedError):
            time.sleep(retry_delay(attempt))
            if consecutive_529 >= 3 and FALLBACK_MODEL:
                state.current_model = FALLBACK_MODEL
```

---

## 十、任务系统（s12 核心）

```python
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str          # pending | in_progress | completed
    owner: str | None
    blockedBy: list[str] # 依赖的任务 ID 列表

# 状态机
# pending ──claim──→ in_progress ──complete──→ completed

def can_start(task_id: str) -> bool:
    """所有 blockedBy 依赖必须 completed"""
    task = load_task(task_id)
    for dep_id in task.blockedBy:
        if load_task(dep_id).status != "completed":
            return False
    return True

def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    if task.status != "pending": return f"Task is {task.status}"
    if task.owner: return f"Already owned by {task.owner}"
    if not can_start(task_id): return "Blocked by dependencies"
    task.owner = owner; task.status = "in_progress"
    save_task(task)
    return f"Claimed {task.id}"

def complete_task(task_id: str) -> str:
    task = load_task(task_id)
    task.status = "completed"
    save_task(task)
    unblocked = find_newly_unblocked()
    return f"Completed. Unblocked: {unblocked}"
```

---

## 十一、MCP 插件（s19 核心）

```python
# 命名规则: mcp__{server}__{tool}
# 例如: mcp__docs__search, mcp__deploy__trigger

def normalize_mcp_name(name: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]', '_', name)

def assemble_tool_pool():
    """组装内置 + MCP 工具"""
    tools = list(BUILTIN_TOOLS)
    handlers = dict(BUILTIN_HANDLERS)
    for server_name, client in mcp_clients.items():
        safe_server = normalize_mcp_name(server_name)
        for tool_def in client.tools:
            safe_tool = normalize_mcp_name(tool_def["name"])
            prefixed = f"mcp__{safe_server}__{safe_tool}"
            tools.append({
                "name": prefixed,
                "description": tool_def.get("description", ""),
                "input_schema": tool_def.get("inputSchema", {}),
            })
            handlers[prefixed] = lambda c=client, t=tool_def["name"], **kw: c.call_tool(t, kw)
    return tools, handlers
```

---

## 十二、设计原则总结

| 原则 | 说明 |
|------|------|
| **循环不变** | 所有的机制都挂在循环外面，循环本身从不改变 |
| **便宜的先跑** | 压缩：budget(snip(micro)) 0 API → auto 1 API → reactive 应急 |
| **加工具只加一行** | TOOLS 加一条描述 + TOOL_HANDLERS 加一个映射 |
| **扩展挂钩子** | 权限、日志、审计都挂 Hook 上，不改循环源码 |
| **上下文集装拆** | 记忆按需加载、技能按需加载、prompt 运行时组装 |
| **子任务隔离** | Subagent 用全新 messages[]，中间过程丢弃只回结论 |
| **文件即状态** | 任务、记忆、worktree、cron 都持久化到文件 |
| **异步解耦** | 后台任务 daemon 线程、cron 独立线程、队友独立线程 |

---

## 十三、CLI Agent vs GUI Agent 架构差异

```
CLI Agent (learn-claude-code)      GUI Agent (Mira)
┌──────────────────┐              ┌──────────────────────┐
│ input() 阻塞等待  │              │ HTTP POST /api/chat   │
│ while True 同步   │              │ AsyncIterable[SSE]    │
│ print() 输出      │              │ StreamingResponse     │
└──────────────────┘              └──────────────────────┘

移植关键:
- subprocess.run → await tool.execute() (异步)
- print() → yield StreamEvent (SSE)
- input() → 等待前端发送 HTTP 请求
- hooks 从同步 → async 回调
```
