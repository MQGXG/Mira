# Mira 开发参考：Agent 模式源码手册

> 用途：Mira Agent Core 开发时的直接代码参考
>
> **参考仓库：**
>
> | 仓库 | 链接 | 定位 |
> |------|------|------|
> | **anomalyco/opencode** | <https://github.com/anomalyco/opencode> | 最大开源编码 Agent（178k★, TS/Bun） |
> | **openai/codex** | <https://github.com/openai/codex> | OpenAI 官方 CLI Agent（93.3k★, Rust） |
> | **shareAI-lab/learn-claude-code** | <https://github.com/shareAI-lab/learn-claude-code> | Agent Harness 从 0 到 1 教学（68.2k★, Python） |
> | **anthropics/claude-code** | <https://github.com/anthropics/claude-code> | 官方 Claude Code 配置/插件层（134k★, 闭源核心） |
> | **claude-code-best/claude-code** | <https://github.com/claude-code-best/claude-code> | Claude Code 开源复刻增强版（20.3k★, TS/Bun） |
> | **XiaomiMiMo/MiMo-Code** | <https://github.com/XiaomiMiMo/MiMo-Code> | OpenCode Fork + 小米 MiMo（10.6k★, TS/Bun） |

---

## 一、Agent 核心循环（所有 Agent 的基础）

### 1.1 最简循环模式

源码来源：`learn-claude-code/s01_agent_loop/code.py`

```python
# ── 核心模式：一个 while 循环，调用工具直到模型停止 ──
def agent_loop(messages: list):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )

        # 追加 assistant 回复
        messages.append({"role": "assistant", "content": response.content})

        # 如果模型没调用工具，就结束
        if response.stop_reason != "tool_use":
            return

        # 执行每个工具调用，收集结果
        results = []
        for block in response.content:
            if block.type == "tool_use":
                output = run_bash(block.input["command"])
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": output,
                })

        # 把工具结果喂回消息，循环继续
        messages.append({"role": "user", "content": results})
```

**Mira 对应代码：** `packages/core/src/agent.ts` — `Agent.run()` 方法

### 1.2 工具分发映射模式

源码来源：`learn-claude-code/s02_tool_use/code.py`

```python
# ── 工具分发映射（s01 硬编码 run_bash，s02 改为查表） ──
TOOL_HANDLERS = {
    "bash": run_bash,
    "read_file": run_read,
    "write_file": run_write,
    "edit_file": run_edit,
    "glob": run_glob,
}

# 循环中只改了工具执行那行
# s01: output = run_bash(block.input["command"])
# s02: output = TOOL_HANDLERS[block.name](**block.input)
```

**核心原则：** 新增一个工具 = 新增一个 handler（主循环不动）
**Mira 对应：** `packages/core/src/tools/index.ts` 的注册模式

---

## 二、三级权限管线

源码来源：`learn-claude-code/s03_permission/code.py`

### 2.1 权限管线架构

```python
# ── 三道门：在工具执行前插入 ──
# 门 1：硬拒绝列表（rm -rf /, sudo, ...）
# 门 2：规则匹配（写到工作区外？破坏性命令？）
# 门 3：用户审批（暂停等待确认）

def check_permission(block) -> bool:
    # 门 1：硬拒绝
    if block.name == "bash":
        reason = check_deny_list(block.input.get("command", ""))
        if reason:
            print(f"\n⛔ {reason}")
            return False

    # 门 2：规则匹配
    reason = check_rules(block.name, block.input)
    if reason:
        # 门 3：用户审批
        decision = ask_user(block.name, block.input, reason)
        if decision == "deny":
            return False

    return True


# 循环中只改了一行：
# s03 change: 在执行前跑权限管线
if not check_permission(block):
    results.append({"type": "tool_result", "tool_use_id": block.id,
                    "content": "Permission denied."})
    continue
```

### 2.2 规则引擎

```python
# 规则定义：上下文相关的检查
PERMISSION_RULES = [
    {"tools": ["write_file", "edit_file"],
     "check": lambda args: not (WORKDIR / args.get("path", "")).resolve().is_relative_to(WORKDIR),
     "message": "Writing outside workspace"},
    {"tools": ["bash"],
     "check": lambda args: any(kw in args.get("command", "") for kw in ["rm ", "> /etc/", "chmod 777"]),
     "message": "Potentially destructive command"},
]
```

### 2.3 用户审批

```python
def ask_user(tool_name: str, args: dict, reason: str) -> str:
    print(f"\n⚠  {reason}")
    print(f"   Tool: {tool_name}({args})")
    choice = input("   Allow? [y/N] ").strip().lower()
    return "allow" if choice in ("y", "yes") else "deny"
```

**Mira 对应：** `packages/core/src/permission.ts` / `permission-gate.ts` 的审批逻辑
**对比 Mira 现状：** Mira 的 `permission_request` 事件 + `PermissionDialog` 与 s03 模式一致

---

## 三、Hook 扩展系统

源码来源：`learn-claude-code/s04_hooks/code.py`

### 3.1 事件点定义

```python
# 5 个 Hook 事件点
HOOKS = {
    "UserPromptSubmit": [],  # 用户提交时
    "PreToolUse": [],        # 工具执行前
    "PostToolUse": [],       # 工具执行后
    "Stop": [],              # 循环停止时
}

def register_hook(event: str, callback):
    HOOKS[event].append(callback)

def trigger_hooks(event: str, *args):
    """触发所有注册的 hook。如果任一返回非 None，立即短路。"""
    for callback in HOOKS[event]:
        result = callback(*args)
        if result is not None:
            return result
    return None
```

### 3.2 Hook 注册示例

```python
# 权限钩子（PreToolUse）
def permission_hook(block):
    if block.name == "bash":
        for p in DENY_LIST:
            if p in block.input.get("command", ""):
                return "Permission denied"
    return None

# 日志钩子
def log_hook(block):
    print(f"[HOOK] {block.name}")
    return None

# 注册
register_hook("PreToolUse", permission_hook)
register_hook("PreToolUse", log_hook)

# 停止钩子（session 结束时）
def summary_hook(messages: list):
    tool_count = sum(1 for m in messages ...)
    print(f"[HOOK] Stop: session used {tool_count} tool calls")
    return None
register_hook("Stop", summary_hook)
```

### 3.3 在循环中的插入点

```python
# PreToolUse
blocked = trigger_hooks("PreToolUse", block)
if blocked:
    results.append({"type": "tool_result", ...})
    continue

# PostToolUse
trigger_hooks("PostToolUse", block, output)

# Stop: 可以返回字符串强制继续循环
force = trigger_hooks("Stop", messages)
if force:
    messages.append({"role": "user", "content": force})
    continue
```

**Mira 对应：** `packages/core/src/plugin-hooks.ts` / `hooks-setup.ts`

---

## 四、SubAgent 模式

源码来源：`learn-claude-code/s06_subagent/code.py`

### 4.1 核心模式

```python
# ── SubAgent：干净上下文 + 摘要返回 ──
#  主 Agent                    SubAgent
#  +----------------+         +----------------+
#  | messages=[...] |         | messages=[任务] | <-- 干净的
#  |                | dispatch|                |
#  | tool: task     | ------> | 自己的 while 循环 |
#  |   prompt="..." |         |   (最多 30 轮)   |
#  | result = "..." | <------ | 返回最后文本     |
#  +----------------+         +----------------+

def spawn_subagent(description: str) -> str:
    """使用干净的 messages[] 衍生子 Agent，只返回摘要。"""
    messages = [{"role": "user", "content": description}]  # 干净的上下文

    for _ in range(30):  # 安全上限
        response = client.messages.create(
            model=MODEL, system=SUB_SYSTEM,
            messages=messages, tools=SUB_TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})
        if response.stop_reason != "tool_use":
            break

        results = []
        for block in response.content:
            if block.type == "tool_use":
                # 子 Agent 也要跑 hook/权限
                blocked = trigger_hooks("PreToolUse", block)
                if blocked:
                    results.append({"type": "tool_result", ...})
                    continue
                handler = SUB_HANDLERS.get(block.name)
                output = handler(**block.input) if handler else f"Unknown: {block.name}"
                results.append({"type": "tool_result", ...})
        messages.append({"role": "user", "content": results})

    # 返回摘要，丢弃完整消息历史
    result = extract_text(messages[-1]["content"])
    return result
```

### 4.2 关键设计要点

```python
# 子 Agent 的 TOOLS 中不注册 "task" 工具——防止递归
SUB_TOOLS = [
    {"name": "bash", ...},
    {"name": "read_file", ...},
    # ... 没有 task 工具
]
# 主 Agent 有 "task" 工具
TOOLS.append({
    "name": "task",
    "description": "Launch a subagent to handle a complex subtask.", ...
})
TOOL_HANDLERS["task"] = spawn_subagent
```

### 4.3 MiMo 的 Single-Writer 增强

源码来源：`MiMo-Code` README 分析

```
关键约束：
  - Single-writer：每个结构化文件只有恰好一个 actor 可写入
  - 主 Agent 只读结构化文件，唯一写通道是 notes.md（自由格式 scratchpad）
  - Writer subagent 在 checkpoint 时读取 notes，路由到对应字段后清空
  - Writer 独立于主 Agent 运行，不共享 token 预算

流程：
  1. 主 Agent 只写 notes.md（自由文本）
  2. 到达 checkpoint 时机（context 20%/45%/70%）
  3. Writer subagent 读取 notes，结构化写入 checkpoint.md
  4. 清空 notes.md
```

**Mira 对应：** `packages/core/src/subagent-manager.ts`

---

## 五、上下文压缩管线

源码来源：`learn-claude-code/s08_context_compact/code.py`

### 5.1 四层压缩管线

```python
"""
四层压缩管线，在 LLM 调用前插入：

    L1: snip_compact          — 消息数 > 50 时裁剪中间消息
    L2: micro_compact         — 旧的 tool_result 替换为占位符
    L3: tool_result_budget    — 大的结果持久化到磁盘
    L4: compact_history       — LLM 全量摘要（1 次 API 调用）

    应急：reactive_compact    — API 返回 prompt_too_long 时触发

    核心原则：便宜的先跑，贵的后跑
    执行顺序：budget → snip → micro → auto
"""
```

### 5.2 L1: 消息裁剪

```python
CONTEXT_LIMIT = 50000
KEEP_RECENT = 3

def snip_compact(messages, max_messages=50):
    """裁剪中间消息，保留开头 3 条 + 末尾 max_messages-3 条。"""
    if len(messages) <= max_messages:
        return messages

    head_end, tail_start = 3, len(messages) - (max_messages - 3)

    # 确保不在 tool_use/tool_result 对中间切开
    if head_end > 0 and _message_has_tool_use(messages[head_end - 1]):
        while head_end < len(messages) and _is_tool_result_message(messages[head_end]):
            head_end += 1
    if (tail_start > 0 and tail_start < len(messages)
            and _is_tool_result_message(messages[tail_start])
            and _message_has_tool_use(messages[tail_start - 1])):
        tail_start -= 1

    if head_end >= tail_start:
        return messages

    snipped = tail_start - head_end
    return messages[:head_end] + [
        {"role": "user", "content": f"[snipped {snipped} messages]"}
    ] + messages[tail_start:]
```

### 5.3 L2: 旧结果占位

```python
def micro_compact(messages):
    """把旧的 tool_result 内容替换为简短占位符。"""
    tool_results = collect_tool_results(messages)
    if len(tool_results) <= KEEP_RECENT:
        return messages

    for _, _, block in tool_results[:-KEEP_RECENT]:
        if len(block.get("content", "")) > 120:
            block["content"] = "[Earlier tool result compacted. Re-run if needed.]"
    return messages
```

### 5.4 L3: 大结果持久化

```python
PERSIST_THRESHOLD = 30000

def persist_large_output(tool_use_id, output):
    """超过阈值的内容持久化到磁盘，只保留预览。"""
    if len(output) <= PERSIST_THRESHOLD:
        return output

    path = TOOL_RESULTS_DIR / f"{tool_use_id}.txt"
    if not path.exists():
        path.write_text(output)
    return f"<persisted-output>\nFull output: {path}\nPreview:\n{output[:2000]}\n</persisted-output>"

def tool_result_budget(messages, max_bytes=200_000):
    """按大小排序，从最大的开始持久化，直到总大小降到阈值以下。"""
    last = messages[-1] if messages else None
    if not last or last.get("role") != "user":
        return messages

    blocks = [(i, b) for i, b in enumerate(last["content"])
              if b.get("type") == "tool_result"]
    total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    if total <= max_bytes:
        return messages

    # 按大小降序排列，从最大的开始处理
    ranked = sorted(blocks, key=lambda p: len(str(p[1].get("content", ""))), reverse=True)
    for _, block in ranked:
        if total <= max_bytes:
            break
        content = str(block.get("content", ""))
        if len(content) <= PERSIST_THRESHOLD:
            continue
        block["content"] = persist_large_output("unknown", content)
        total = sum(len(str(b.get("content", ""))) for _, b in blocks)
    return messages
```

### 5.5 L4: LLM 摘要 + 应急

```python
def compact_history(messages):
    """使用 LLM 对整个对话做摘要。"""
    transcript_path = write_transcript(messages)  # 先备份
    summary = summarize_history(messages)         # 1 次 LLM 调用
    return [{"role": "user", "content": f"[Compacted]\n\n{summary}"}]

def reactive_compact(messages):
    """应急压缩：当 API 返回 prompt_too_long 时触发。"""
    # 保留最近的 5 条消息，之前的全部摘要
    transcript = write_transcript(messages)
    tail_start = max(0, len(messages) - 5)
    summary = summarize_history(messages[:tail_start])
    return [{"role": "user", "content": f"[Reactive compact]\n\n{summary}"}, *messages[tail_start:]]
```

### 5.6 循环中的整合

```python
def agent_loop(messages: list):
    reactive_retries = 0
    while True:
        # 三个预处理器（0 次 API 调用，便宜的先跑）
        messages[:] = tool_result_budget(messages)   # L3: 先持久化大结果
        messages[:] = snip_compact(messages)          # L1: 裁剪中间
        messages[:] = micro_compact(messages)         # L2: 旧结果占位

        # 如果仍然超过阈值 → LLM 摘要（1 次 API 调用）
        if estimate_size(messages) > CONTEXT_LIMIT:
            print("[auto compact]")
            messages[:] = compact_history(messages)

        try:
            response = client.messages.create(...)
            reactive_retries = 0
        except Exception as e:
            if "prompt_too_long" in str(e).lower() and reactive_retries < 1:
                messages[:] = reactive_compact(messages)
                reactive_retries += 1
                continue
            raise
        # ... 继续循环
```

### 5.7 MiMo 的 Cycle 机制增强

源码来源：MiMo-Code 架构分析

```
MiMo 的 Cycle 机制（提前 checkpoint 实现无限会话）：

  触发时机：在 context budget 的 20%、45%、70% 处提前触发
          而非等到窗口快满才处理

  理由：
    1. 模型在高上下文利用率下能力衰减（lost in the middle）
    2. 提取本身需要空间（writer 需要读历史并维持解读）

  Checkpoint writer 独立执行（主 Agent 继续工作）

  Rebuild 注入内容（约 65K token）：
    - 任务清单 → session checkpoint → 最近用户消息逐字切片
    - 项目记忆 → 全局记忆 → notes → 文件路径索引 → tail reminder

  Cycle 无上限：物理窗口有界，逻辑会话无限
```

**Mira 对应：** `packages/core/src/context-manager.ts`

---

## 六、记忆系统

源码来源：`learn-claude-code/s09_memory/code.py` + MiMo-Code 4层记忆

### 6.1 记忆文件结构

```python
MEMORY_DIR = ".memory/"
# MEMORY.md    ← 索引（每条记忆一行，≤200 行）
# 用户偏好.md   ← 单个记忆文件（Markdown + YAML frontmatter）
# 项目事实.md
# ...

def write_memory_file(name, mem_type, description, body):
    """写入单个记忆文件，带 YAML frontmatter。"""
    slug = name.lower().replace(" ", "-")
    filename = f"{slug}.md"
    filepath = MEMORY_DIR / filename
    filepath.write_text(
        f"---\nname: {name}\ndescription: {description}\ntype: {mem_type}\n---\n\n{body}\n"
    )
    _rebuild_index()

def _rebuild_index():
    """从所有记忆文件重建 MEMORY.md 索引。"""
    lines = []
    for f in sorted(MEMORY_DIR.glob("*.md")):
        if f.name == "MEMORY.md":
            continue
        raw = f.read_text()
        meta, body = _parse_frontmatter(raw)
        name = meta.get("name", f.stem)
        desc = meta.get("description", body.split("\n")[0][:80])
        lines.append(f"- [{name}]({f.name}) — {desc}")
    MEMORY_INDEX.write_text("\n".join(lines) + "\n" if lines else "")
```

### 6.2 记忆选择和注入

```python
def select_relevant_memories(messages, max_items=5):
    """选择与当前会话相关的记忆文件。"""
    files = list_memory_files()
    if not files:
        return []

    # 从最近 3 条用户消息中提取上下文
    recent_texts = []
    for msg in reversed(messages):
        if msg.get("role") == "user":
            recent_texts.append(msg.get("content", ""))
            if len(recent_texts) >= 3:
                break
    recent = " ".join(reversed(recent_texts))[:2000]

    # 用 LLM 选择相关记忆（或 fallback 到关键词匹配）
    prompt = (
        "Given the recent conversation and the memory catalog below, "
        "select the indices of memories that are clearly relevant. "
        "Return ONLY a JSON array of integers, e.g. [0, 3]. "
        f"Recent: {recent}\nCatalog: {catalog}"
    )
    # ... 解析 LLM 响应，返回选中的 filename

def load_memories(messages):
    """加载相关记忆内容注入上下文。"""
    selected_files = select_relevant_memories(messages)
    if not selected_files:
        return ""
    parts = ["<relevant_memories>"]
    for filename in selected_files:
        content = read_memory_file(filename)
        if content:
            parts.append(content)
    parts.append("</relevant_memories>")
    return "\n\n".join(parts)
```

### 6.3 记忆提取（每轮运行）

```python
def extract_memories(messages):
    """从最近的对话中提取新记忆。在每轮结束后运行。"""
    # 收集最近对话文本（取最近 10 条）
    dialogue = "\n".join(
        f"{m['role']}: {str(m.get('content', ''))[:200]}"
        for m in messages[-10:]
    )

    prompt = (
        "Extract user preferences, constraints, or project facts.\n"
        "Return JSON array: [{name, type, description, body}].\n"
        "If nothing new, return [].\n\n"
        f"Dialogue:\n{dialogue[:4000]}"
    )

    response = client.messages.create(...)
    items = json.loads(extract_text(response.content))
    for mem in items:
        write_memory_file(
            name=mem["name"],
            mem_type=mem.get("type", "user"),
            description=mem["description"],
            body=mem["body"],
        )
```

### 6.4 记忆合并（Consolidation / Dream）

```python
CONSOLIDATE_THRESHOLD = 10  # 记忆文件数超过 10 时触发

def consolidate_memories():
    """合并重复/过时的记忆。"""
    files = list_memory_files()
    if len(files) < CONSOLIDATE_THRESHOLD:
        return

    prompt = (
        "Consolidate these memory files:\n"
        "1. Merge duplicates into one\n"
        "2. Remove outdated/contradicted memories\n"
        "3. Keep total under 30\n"
        "4. Preserve user preferences above all\n"
        "Return JSON array.\n\n"
        f"{catalog[:16000]}"
    )

    response = client.messages.create(...)
    items = json.loads(extract_text(response.content))

    # 清除旧文件，写入合并后的
    for f in MEMORY_DIR.glob("*.md"):
        if f.name != "MEMORY.md":
            f.unlink()
    for mem in items:
        write_memory_file(...)
```

### 6.5 MiMo 的四层记忆架构

```
MiMo 记忆架构：

  ┌──────────────────────────────────────────┐
  │  Global Memory (用户级，跨所有项目)        │  ← 最顶层
  │       ↑ promotion（手动提升）              │
  │  ┌────────────────────────────────────┐   │
  │  │  Project Memory (MEMORY.md，项目级)  │   │
  │  │       ↑ promotion（多次稳定的才提升） │   │
  │  │  ┌──────────────────────────────┐  │   │
  │  │  │  Session Memory (checkpoint) │  │   │
  │  │  │       ↑ writing              │  │   │
  │  │  │  History (SQLite，全量原始轨迹)  │  │   │
  │  │  └──────────────────────────────┘  │   │
  │  └────────────────────────────────────┘   │
  └──────────────────────────────────────────┘

  Session checkpoint 的 11 个结构化字段：
  1. 意图（intent）
  2. 下一步（next_steps）
  3. 约束（constraints）
  4. 任务树（task_tree）
  5. 当前工作（current_work）
  6. 涉及文件（files_touched）
  7. 发现（findings）
  8. 错误修复（error_fixes）
  9. 运行时状态（runtime_state）
  10. 设计决策（design_decisions）
  11. 杂项笔记（misc_notes）
```

**Mira 对应：** `packages/core/src/memory/` 目录（Builtin / Vector / File / FTS）
**对应参考：** 将 session-manager 中的 session 持久化升级为带 promotion 的 4 层记忆

---

## 七、权限模型（OpenCode 参考）

源码来源：`opencode` 架构分析

### 7.1 三级控制

```typescript
// OpenCode 的权限模型
type PermissionLevel = "allow" | "ask" | "deny";

interface PermissionRule {
  action: string;       // 权限动作，如 "bash", "write_file", "read_file"
  resource: string;     // 通配符匹配模式，如 "**/*.ts", "/etc/**"
  level: PermissionLevel;
  duration?: number;    // 临时允许时长（毫秒）
}

// 权限解析：支持通配符模式叠加
// 精确到单个 bash 命令级别
```

### 7.2 OpenCode 的通配符模式

```typescript
// 通配符模式匹配（如 **/*.secret → deny）
// 精确到命令级别，如：
//   bash: "rm -rf /"     → deny
//   bash: "npm install"  → allow
//   write: "/etc/**"     → ask
```

**Mira 对应：** `packages/core/src/permission.ts` — 当前为工具级别，可向命令级别细化

---

## 八、工程化规范（Codex CLI 参考）

源码来源：`openai/codex` 架构分析

### 8.1 上下文管理硬规则

```rust
// Codex CLI 的上下文管理规则：
// 1. 禁止历史重写，必须增量构建
// 2. 每个注入项必须有界且上限 10K tokens
// 3. 所有注入片段必须实现 ContextualUserFragment trait
```

### 8.2 代码质量红线

```typescript
// Codex CLI 的工程规范（从 AGENTS.md 提取）：
// 1. 单个模块不超过 500 行/800 行红线
// 2. 反对 async_trait，优先用 RPITIT
// 3. 强制 exhaustive match
// 4. 抵制向 codex-core 加代码 → 鼓励拆新 crate
// 5. 快照测试锁定 UI 输出
// 6. 集成测试优先：core/suite/ 中的端到端测试
```

---

## 九、多 Agent 协作模式

### 9.1 工作流引擎（CCB Ultracode）

源码来源：`claude-code-best` 架构分析

```javascript
// Ultracode 的工作流编排（确定性 JS 脚本）
// Workflow 工具运行确定性脚本，具有幂等性和可重放性

const workflow = {
  phases: [
    {
      name: "plan",
      mode: "agent",          // 单个 agent 执行
      prompt: "设计架构方案"
    },
    {
      name: "develop",
      mode: "parallel",       // 多个 agent 并行
      agents: [
        { task: "实现模块 A" },
        { task: "实现模块 B" }
      ]
    },
    {
      name: "review",
      mode: "pipeline",       // 流水线串联
      steps: ["code review", "test", "merge"]
    }
  ]
};
```

### 9.2 Agent 团队模式

源码来源：`learn-claude-code/s15_agent_teams/` 和 `s17_autonomous_agents/`

```
Agent 团队通信（15 种消息类型）：
  - plain_text
  - idle_notification
  - permission_request / permission_response
  - plan_approval_request / plan_approval_response
  - shutdown_request / shutdown_approved / shutdown_rejected
  - task_assignment
  - team_permission_update
  - mode_set_request
  - sandbox_permission_*
  - teammate_terminated

自主 Agent（s17）：
  - idle cycle：每 30 秒检查是否有待处理工作
  - auto-claim：从共享看板自动认领任务
  - 自组织：无需领导分配
```

**Mira 对应：** `packages/core/src/team-bus.ts` / `delegate-runner.ts`

---

## 十、设计原则速查表

| # | 原则 | 来源 | 说明 |
|---|------|------|------|
| 1 | **循环属于 Agent，机制属于 Harness** | s01 | 主循环永不改变，功能作为机制挂载在循环周围 |
| 2 | **便宜的先跑，贵的后跑** | s08 | 先 0 API 的文本操作，再 1 API 的 LLM 摘要 |
| 3 | **先划边界，再给自由** | s03 | 权限在前，工具在后 |
| 4 | **用到时再加载，别全塞 prompt** | s07 | 技能按需加载（SkillManifest） |
| 5 | **很多机制，一个循环** | s20 | 一切回归同一个 while True |
| 6 | **Single-writer** | MiMo | 每个持久文件只有一个写者，避免并发冲突 |
| 7 | **提前 checkpoint** | MiMo | 在 20%/45%/70% context 处提前提取，而非窗口满时 |
| 8 | **抗膨胀** | Codex | 抵制向核心加代码，模块 ≤500 行 |
| 9 | **没有计划的 agent 走哪算哪** | s05 | 先 todo_write 规划，再执行 |
| 10 | **错误不是终点，是重试的起点** | s11 | 重试、腾空间、换路子 |

---

## 十一、Mira 当前架构对照索引

| Mira 模块 | 对应参考源码 | 建议改进方向 |
|-----------|------------|-------------|
| `packages/core/src/agent.ts` | [s01 Agent Loop](https://github.com/shareAI-lab/learn-claude-code/blob/main/s01_agent_loop/code.py) + [s04 Hooks](https://github.com/shareAI-lab/learn-claude-code/blob/main/s04_hooks/code.py) | 引入 Hook 事件点（PreToolUse/PostToolUse） |
| `packages/core/src/tools/` | [s02 TOOL_HANDLERS](https://github.com/shareAI-lab/learn-claude-code/blob/main/s02_tool_use/code.py) | 保持 dispatch 模式，扩展更方便 |
| `packages/core/src/permission.ts` | [s03 三级管线](https://github.com/shareAI-lab/learn-claude-code/blob/main/s03_permission/code.py) + [OpenCode permission/](https://github.com/anomalyco/opencode/tree/dev/packages/core/src/permission) | 从工具级别细化到命令级别 |
| `packages/core/src/context-manager.ts` | [s08 四层压缩](https://github.com/shareAI-lab/learn-claude-code/blob/main/s08_context_compact/code.py) + MiMo Cycle | 实现 20%/45%/70% 提前 checkpoint |
| `packages/core/src/memory/` | [s09 记忆三阶段](https://github.com/shareAI-lab/learn-claude-code/blob/main/s09_memory/code.py) + MiMo 4 层 | 增加 Session→Project→Global promotion |
| `packages/core/src/subagent-manager.ts` | [s06 SubAgent](https://github.com/shareAI-lab/learn-claude-code/blob/main/s06_subagent/code.py) + MiMo Single-writer | 分离 writer subagent，主 Agent 只写 notes |
| `packages/core/src/goal-judge.ts` | MiMo Goal 独立 Judge（[README](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/README.md)） | 增加误拦率优化 |
| `packages/core/src/dream-distill.ts` | MiMo Dream/Distill + [s09 consolidate](https://github.com/shareAI-lab/learn-claude-code/blob/main/s09_memory/code.py) | 合并去重逻辑参考 |
| `packages/core/src/plugin-hooks.ts` | [s04 Hook 系统](https://github.com/shareAI-lab/learn-claude-code/blob/main/s04_hooks/code.py) | 扩展 hook 事件点 |
| `packages/electron/src/ipc/` | s03 权限弹窗 | 权限冒泡到子 Agent |

---

---

## 附录：仓库版本与源文件路径

| 仓库 | 分支 | 关键源码路径 | 直接查看 |
|------|------|-------------|---------|
| shareAI-lab/learn-claude-code | `main` | `s01_agent_loop/code.py` ~ `s20_comprehensive/code.py` | [s01 Agent Loop](https://github.com/shareAI-lab/learn-claude-code/blob/main/s01_agent_loop/code.py) · [s02 Tool Use](https://github.com/shareAI-lab/learn-claude-code/blob/main/s02_tool_use/code.py) · [s03 Permission](https://github.com/shareAI-lab/learn-claude-code/blob/main/s03_permission/code.py) · [s04 Hooks](https://github.com/shareAI-lab/learn-claude-code/blob/main/s04_hooks/code.py) · [s08 Context Compact](https://github.com/shareAI-lab/learn-claude-code/blob/main/s08_context_compact/code.py) · [s09 Memory](https://github.com/shareAI-lab/learn-claude-code/blob/main/s09_memory/code.py) · [s12 Task System](https://github.com/shareAI-lab/learn-claude-code/blob/main/s12_task_system/code.py) |
| anomalyco/opencode | `dev` | `packages/core/src/` | [agent.ts](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/agent.ts) · [permission/](https://github.com/anomalyco/opencode/tree/dev/packages/core/src/permission) · [tool/](https://github.com/anomalyco/opencode/tree/dev/packages/core/src/tool) |
| openai/codex | `main` | `codex-rs/core/src/`（Rust） | [AGENTS.md](https://github.com/openai/codex/blob/main/AGENTS.md) · [core/context/](https://github.com/openai/codex/tree/main/codex-rs/core/src/context) |
| claude-code-best/claude-code | `main` | `src/` | [assistant/](https://github.com/claude-code-best/claude-code/tree/main/src/assistant) · [commands/](https://github.com/claude-code-best/claude-code/tree/main/src/commands) · [services/](https://github.com/claude-code-best/claude-code/tree/main/src/services) |
| anthropics/claude-code | `main` | `plugins/` | [plugins/](https://github.com/anthropics/claude-code/tree/main/plugins) · [.claude/commands/](https://github.com/anthropics/claude-code/tree/main/.claude/commands) |
| XiaomiMiMo/MiMo-Code | `main` | `packages/opencode/` | [README.md](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/README.md) · [packages/](https://github.com/XiaomiMiMo/MiMo-Code/tree/main/packages) |

### 各章节对应的源码参考链接

| 章节 | 参考源码 | 链接 |
|------|---------|------|
| §1 Agent 核心循环 | learn-claude-code s01 | [s01_agent_loop/code.py](https://github.com/shareAI-lab/learn-claude-code/blob/main/s01_agent_loop/code.py) |
| §2 工具分发映射 | learn-claude-code s02 | [s02_tool_use/code.py](https://github.com/shareAI-lab/learn-claude-code/blob/main/s02_tool_use/code.py) |
| §3 权限管线 | learn-claude-code s03 + OpenCode permission/ | [s03_permission/code.py](https://github.com/shareAI-lab/learn-claude-code/blob/main/s03_permission/code.py) · [OpenCode permission/](https://github.com/anomalyco/opencode/tree/dev/packages/core/src/permission) |
| §4 Hook 系统 | learn-claude-code s04 | [s04_hooks/code.py](https://github.com/shareAI-lab/learn-claude-code/blob/main/s04_hooks/code.py) |
| §5 SubAgent | learn-claude-code s06 | [s06_subagent/code.py](https://github.com/shareAI-lab/learn-claude-code/blob/main/s06_subagent/code.py) |
| §6 上下文压缩 | learn-claude-code s08 | [s08_context_compact/code.py](https://github.com/shareAI-lab/learn-claude-code/blob/main/s08_context_compact/code.py) |
| §7 记忆系统 | learn-claude-code s09 + MiMo 4 层 | [s09_memory/code.py](https://github.com/shareAI-lab/learn-claude-code/blob/main/s09_memory/code.py) · [MiMo README](https://github.com/XiaomiMiMo/MiMo-Code/blob/main/README.md) |
| §8 权限模型（OpenCode） | OpenCode permission/ | [OpenCode permission/](https://github.com/anomalyco/opencode/tree/dev/packages/core/src/permission) |
| §9 多 Agent 协作 | learn-claude-code s15-s17 + CCB | [s15_agent_teams/](https://github.com/shareAI-lab/learn-claude-code/tree/main/s15_agent_teams) · [CCB src/](https://github.com/claude-code-best/claude-code/tree/main/src) |
| §10 工程化规范 | Codex CLI AGENTS.md | [Codex AGENTS.md](https://github.com/openai/codex/blob/main/AGENTS.md) |

### 获取源码的方式

```bash
# 1. learn-claude-code（推荐最先看，Python 教学版最清晰）
git clone --depth 1 https://github.com/shareAI-lab/learn-claude-code.git
# 重点：s01 ~ s20 的 code.py 文件

# 2. OpenCode（TS 生产级实现）
git clone --depth 1 https://github.com/anomalyco/opencode.git
# 重点：packages/core/src/

# 3. Codex CLI（Rust 工程化参考）
git clone --depth 1 https://github.com/openai/codex.git
# 重点：codex-rs/core/ + AGENTS.md

# 4. MiMo-Code（小米 Fork，记忆系统参考）
git clone --depth 1 https://github.com/XiaomiMiMo/MiMo-Code.git
# 重点：packages/opencode/

# 5. CCB（Claude Code 社区复刻，增强功能参考）
git clone --depth 1 https://github.com/claude-code-best/claude-code.git
# 重点：src/assistant/ + src/commands/

# 6. Claude Code 官方（插件/配置参考）
git clone --depth 1 https://github.com/anthropics/claude-code.git
# 重点：plugins/ + .claude/commands/
```

*参考日期：2026-06-24*
