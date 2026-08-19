# OmniAgent 工具系统修复与重构实施计划

> **目标:** 让 OmniAgent 真正"能干活的"——修复工具调用链，使 Agent 能读取文件、搜索网络、执行代码等

**架构分析:** 当前工具系统有三大断裂点:
1. **配置断裂** — `.env` 找不到、API Key 未加载，LLM 无法初始化
2. **消息断裂** — `normalize_messages` 丢弃 `tool_calls`/`tool_call_id`，`_sanitize_history` 截断工具链
3. **执行断裂** — 工具模式过滤限制、缺少 ToolContext、异步阻塞调用

**参考:** OpenCode 的 Session Runner（`packages/core/src/session/runner/llm.ts`）—— 持久化工具调用 → 并发执行 → 收集结果 → 继续循环

---

### Task 1: 修复 `.env` 加载链

**Files:**
- Modify: `agent-backend/app/config.py`
- Modify: `agent-backend/app/api/chat.py`

**问题:** `.env` 不存在/读取位置错误 → API Key 为空 → LLM 初始化失败 → 500 错误

**修改 `config.py`:** 现在已修复——搜索多个位置（根目录/backend/.env/.env.example），设为环境变量

**修改 `chat.py`:** 现在已修复——缺失 Key 时返回清晰的 SSE 错误，而非 500 崩溃

**验证:**
```bash
cd agent-backend
python -c "from app.config import settings; print(f'key=[{settings.openai_api_key}]')"
```

---

### Task 2: 修复消息规范化（工具链断裂）

**Files:**
- Modify: `agent-backend/app/core/normalize.py` ✅ 已修复
- Modify: `agent-backend/app/api/chat.py`（_sanitize_history）✅ 已修复

**normalize.py 问题:** 丢弃 `tool_calls`（assistant 消息）和 `tool_call_id`（tool 消息），导致 LLM 收不到历史工具调用

**修复后行为:** 按角色保留协议字段:
- `assistant` → `role` + `content` + `tool_calls`
- `tool` → `role` + `content` + `tool_call_id`
- `user`/`system` → `role` + `content`

**_sanitize_history 修复:** 保留所有有效消息，只移除真正的孤立消息。不再严格配对 tool_call_id。

---

### Task 3: 修复工具模式限制

**Files:**
- Modify: `agent-backend/app/core/modes.py` ✅ 已修复

**问题:** `allowed_tools` 白名单限制，ASSISTANT/EXPERT/SAFE 模式只能使用少数工具

**修复:** 所有模式的 `allowed_tools` 改为空列表（全部允许），模式只影响系统提示词和迭代次数

---

### Task 4: 修复工具执行缺少上下文

**Files:**
- Modify: `agent-backend/app/core/agent.py` ✅ 已修复

**问题:** `agent.py` 调用 `self.tools.execute(name, args)` 未传 `ToolContext`

**修复:** 传入 `ToolContext(mode=self.mode.value, workspace_path=str(workspace.path))`

---

### Task 5: 修复异步阻塞调用（GrepTool/GlobTool）

**Files:**
- Modify: `agent-backend/app/tools/search_tools.py`

**问题:** `subprocess.run()` 是同步阻塞调用，会阻塞整个事件循环

**修复方案:** 改用 `asyncio.create_subprocess_exec()` 异步执行

```python
# 修改前
import subprocess
result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

# 修改后
import asyncio
proc = await asyncio.create_subprocess_exec(
    *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
)
stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
```

---

### Task 6: 修复 WebSearchTool 同步阻塞

**Files:**
- Modify: `agent-backend/app/tools/search.py`

**问题:** `DDGS()` 同步上下文管理器在异步函数中阻塞事件循环

**修复方案:** 改用 `async_ddg` 或在线程池中执行

```python
async def execute(self, query: str = "", **kwargs) -> ToolResult:
    try:
        from duckduckgo_search import AsyncDDGS
        # 方式1: 使用异步版本
        async with AsyncDDGS() as ddgs:
            results = []
            async for r in ddgs.text(query, max_results=5):
                results.append(r)
        
        # 方式2: 或在线程池中执行（兜底）
        # loop = asyncio.get_event_loop()
        # results = await loop.run_in_executor(None, lambda: list(DDGS().text(query, max_results=5)))
    except Exception as e:
        return ToolResult(success=False, error=str(e))
```

---

### Task 7: 添加工具路径安全检查（基类级别）

**Files:**
- Modify: `agent-backend/app/tools/base.py`

**问题:** 文件路径逃逸检查由每个工具各自实现，不一致且可能遗漏

**借鉴 OpenCode:** `FileSystem.read` 统一检查 `FSUtil.contains(root, real)`

**修复方案:** 在 `ToolContext` 或 `BaseTool` 中添加统一路径安全方法：

```python
# base.py 新增
class BaseTool(ABC):
    def _check_path_safety(self, path: str) -> Path:
        """统一路径安全检查：禁止逃逸到工作目录之外"""
        from app.core.workspace import workspace
        from pathlib import Path
        
        resolved = workspace.resolve(path)
        if not workspace.is_inside(resolved):
            raise PermissionError(f"路径 {resolved} 超出工作目录范围")
        return resolved
```

然后各文件工具统一调用 `self._check_path_safety(path)`。

---

### Task 8: 为工具添加 Schema 验证（执行前）

**Files:**
- Modify: `agent-backend/app/tools/base.py`
- Modify: `agent-backend/app/tools/registry.py`

**借鉴 OpenCode:** 工具定义包含 `input Schema`，执行前自动解码验证

**OmniAgent 现状:** `validate_args` 仅检查必需参数是否存在，不做类型校验

**修复方案:** 在 `ToolParam` 中添加类型校验，注册表执行前统一校验：

```python
# base.py ToolParam
def validate_value(self, name: str, value: Any) -> tuple[bool, str]:
    """验证参数值类型"""
    if self.type == "integer" and value is not None:
        if not isinstance(value, int):
            return False, f"参数 {name} 应为整数，实际为 {type(value).__name__}"
    elif self.type == "number" and value is not None:
        if not isinstance(value, (int, float)):
            return False, f"参数 {name} 应为数字"
    return True, ""

# registry.py 执行前校验
valid, err_msg = tool.validate_args(args)
if not valid:
    return ToolResult(success=False, error=err_msg)
# 新增：类型校验
for p in tool.parameters:
    if p.name in args:
        valid, err_msg = p.validate_value(p.name, args[p.name])
        if not valid:
            return ToolResult(success=False, error=err_msg)
```

---

### Task 9: 添加 LLM 流式错误恢复

**Files:**
- Modify: `agent-backend/app/core/agent.py`（已有恢复逻辑但需要强化）

**借鉴 OpenCode:** `llm.ts` 中的 `runTurnAttempt`:
- `isContextOverflowFailure` → 上下文溢出自动压缩重试
- `retryAgentMismatch` → Agent 配置变更自动重建
- `StepLimitExceededError` → 步数限制明确报错

**强化方案:**
```python
# 在 agent.py 的 run 方法中
MAX_STEPS = 25  # 硬限制
for iteration in range(min(max_iter, MAX_STEPS)):
    try:
        async for event in self.llm.chat_stream(clean_messages, tools=tools):
            ...
    except Exception as e:
        if "context_length_exceeded" in str(e):
            # 上下文溢出：触发压缩后重试
            messages = await compact.reactive_compact(messages, self._llm_summary_call)
            continue
        if "rate_limit" in str(e).lower():
            # 限流：退避重试
            await asyncio.sleep(5)
            continue
        raise
```

---

### Task 10: 添加工具执行超时

**Files:**
- Modify: `agent-backend/app/core/agent.py`
- Modify: `agent-backend/app/tools/registry.py`

**问题:** 工具执行没有超时，网络请求/代码执行可能永久挂起

**借鉴 OpenCode:** `FiberSet.run` + `Effect.raceFirst` 支持超时取消

**修复方案:**
```python
# registry.py
async def execute(self, name, args, context=None, timeout=60):
    try:
        result = await asyncio.wait_for(
            tool.execute(context=context, **args),
            timeout=timeout
        )
    except asyncio.TimeoutError:
        return ToolResult(success=False, error=f"工具 {name} 执行超时 ({timeout}s)")
```

---

### Task 11: 添加工具输出截断

**Files:**
- Modify: `agent-backend/app/tools/base.py` 或 `agent-backend/app/core/agent.py`

**借鉴 OpenCode:** `ToolOutputStore.bound()` 自动截断大输出

**问题:** 文件读取可能返回数 MB 内容，导致上下文爆炸

**修复方案:**
```python
# agent.py 执行工具后
MAX_OUTPUT_CHARS = 10000
if len(result.output) > MAX_OUTPUT_CHARS:
    truncated = result.output[:MAX_OUTPUT_CHARS]
    result.output = f"{truncated}\n\n...(输出过长，截断至 {MAX_OUTPUT_CHARS} 字符，共 {len(result.output)} 字符)"
```

---

### Task 12: 完善前端错误显示

**Files:**
- Modify: `src/components/chat/ChatWindow.tsx`

**问题:** 后端 500 错误在前端显示不清晰

**现状:** `onError` 回调已存在，但 `useChatStream.ts` 的 SSE 解析能处理 `type: "error"`

**检查点:** 确保 ChatWindow 能正确处理并显示所有 SSE 事件类型（特别是后端返回的 API Key 缺失提示）

---

## 实施优先级

| 优先级 | Task | 工作量 | 影响 |
|--------|------|--------|------|
| P0 | Task 1-4（配置、消息、模式、上下文） | 已完成 | 🔴 不修复则工具完全不可用 |
| P1 | Task 5-6（异步阻塞） | 小 | 🔴 grep/web_search 挂起事件循环 |
| P2 | Task 7-8（路径安全、Schema） | 中 | 🟡 防止路径逃逸、参数错误 |
| P3 | Task 9-10（错误恢复、超时） | 中 | 🟡 提高稳定性 |
| P4 | Task 11-12（截断、前端） | 小 | 🟢 体验优化 |

## 验证方法

修复后测试流程:
1. 启动后端: `cd agent-backend && python -m uvicorn app.main:app --reload`
2. 测试健康检查: `curl http://127.0.0.1:8230/health`
3. 创建测试会话: `POST /api/projects/{id}/sessions`
4. 发送消息要求"读取当前目录的 package.json"
5. 检查 SSE 流中是否出现 `tool_start` + `tool_result` 事件
6. 前端应显示工具调用和执行结果
