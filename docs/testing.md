# 测试指南

## 测试框架

项目使用 **Vitest** 作为测试框架，测试文件位于各包的 `__tests__/` 目录。

## 运行测试

```powershell
# 运行所有测试
pnpm test

# 监视模式（开发时使用）
pnpm test:ui

# TypeScript 类型检查
pnpm typecheck
```

## 测试文件结构

```
packages/
├── core/src/__tests__/           # 核心逻辑测试（数量以当前 Vitest 输出为准）
│   ├── setup.ts                  # 初始化平台路径 + 内存 SQLite
│   ├── agent.test.ts             # Agent 端到端运行（工具使用、流式）
│   ├── benchmark.test.ts         # Agent 性能/迭代基准
│   ├── compaction.test.ts        # 上下文压缩
│   ├── context-epoch.test.ts     # 上下文纪元/检查点
│   ├── context-source.test.ts    # 系统上下文 Source
│   ├── cost.test.ts              # Token 成本计算
│   ├── create-chart.test.ts      # create_chart SVG
│   ├── create-doc.test.ts        # create_xlsx / create_pptx
│   ├── create-visual.test.ts     # create_svg / create_webpage / create_mockup
│   ├── dynamic-memory.test.ts    # 动态记忆图谱 + memory_* 工具
│   ├── failover.test.ts          # LLM 故障转移
│   ├── file-state-cache.test.ts  # 文件状态缓存（stale 检测）
│   ├── graph.test.ts             # Graph Engineering 引擎
│   ├── llm-sdk.test.ts           # LLM 客户端
│   ├── memory-manager.test.ts    # 记忆管理器
│   ├── message-utils.test.ts     # 消息工具函数
│   ├── permission-loop.test.ts   # 权限门控/审批循环
│   ├── plugin-hooks.test.ts      # 插件钩子
│   ├── provider-catalog.test.ts  # Provider 目录
│   ├── reasoning-content.test.ts # 推理内容 Part
│   ├── event-sourcing.test.ts    # 事件溯源闭环（投影重建/删除事件/Map 扩展）
│   ├── token-meter-tool-pairing.test.ts # token 估算 + 工具配对平衡 + 压缩收益
│   ├── session-improvement.test.ts # 会话改进（Source/事件溯源/ScopedToolRegistry）
│   ├── session-snapshot.test.ts  # 会话快照
│   ├── smoke.test.ts             # 冒烟测试
│   ├── state-machine.test.ts     # 生命周期状态机
│   ├── tool.test.ts              # 工具工厂 (make/settle)
│   └── tools-core.test.ts        # read/write/edit 纯函数
├── ui/src/chat/__tests__/        # UI 测试
│   ├── tool-router.test.ts       # 工具路由测试
│   ├── follow-up-suggestions.test.ts
│   └── zod-schema.test.ts
└── ui/src/components/assistant-ui/
    └── widget-utils.test.ts      # Widget 提取逻辑
```

## 编写测试

### 单元测试

测试文件放在 `__tests__/` 目录下，文件名以 `.test.ts` 结尾：

```typescript
import { describe, it, expect } from 'vitest'
import { myFunction } from '../my-module'

describe('myFunction', () => {
  it('should do something', () => {
    const result = myFunction('input')
    expect(result).toBe('expected')
  })

  it('should handle edge cases', () => {
    expect(() => myFunction('')).toThrow()
  })
})
```

### Mock

```typescript
import { vi, describe, it, expect } from 'vitest'

// Mock 模块
vi.mock('../external-module', () => ({
  externalFunction: vi.fn().mockResolvedValue('mocked')
}))

// Mock 函数
const mockCallback = vi.fn()

// Spy
const spy = vi.spyOn(object, 'method')
```

### 集成测试

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { Agent } from '../agent'
import { ToolRegistry } from '../registry'

describe('Agent Integration', () => {
  let agent: Agent
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
    // 注册测试工具
    agent = new Agent({ registry, ... })
  })

  it('should execute tool calls', async () => {
    // 测试 Agent 执行流程
  })
})
```

## 测试类型

### 冒烟测试

验证基本功能可用：

```typescript
describe('Smoke Tests', () => {
  it('should initialize agent', () => {
    expect(agent).toBeDefined()
  })

  it('should have all tools registered', () => {
    expect(registry.getAll().length).toBeGreaterThan(0)
  })
})
```

### 单元测试

测试单个函数/类的行为：

```typescript
describe('PermissionSet', () => {
  it('should match wildcard patterns', () => {
    const permissions = new PermissionSet([
      { action: 'bash', resource: 'ls *', effect: 'allow' }
    ])
    expect(permissions.evaluate('bash', 'ls -la')).toBe('allow')
  })
})
```

### 集成测试

测试模块间交互：

```typescript
describe('Agent + LLM', () => {
  it('should stream responses', async () => {
    const events = []
    for await (const event of agent.run({ messages: [...] })) {
      events.push(event)
    }
    expect(events.some(e => e.type === 'content')).toBe(true)
  })
})
```

## 覆盖率

```bash
# 生成覆盖率报告
pnpm test -- --coverage

# 查看 HTML 报告
open coverage/index.html
```

## 性能测试

```typescript
describe('Performance', () => {
  it('should process messages within budget', async () => {
    const start = Date.now()
    await agent.run({ messages: [...] })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(5000) // 5 秒内完成
  })
})
```

## CI/CD

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: pnpm install
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```
