# 贡献指南

感谢您对 Mira 的关注！以下指南帮助您参与项目开发。

## 开发环境

- Node.js 18+
- pnpm 8+
- Windows / macOS / Linux
- **无需 Python**（Agent Core 完全由 TypeScript 实现）

```powershell
# 克隆后首次设置
pnpm install

# 开发模式启动
pnpm dev
```

## 代码规范

### TypeScript / React

- 使用 TypeScript 严格模式，避免 `any`
- 组件使用函数组件 + hooks，避免 class 组件
- 文件名使用 kebab-case（如 `chat-window.tsx`）
- 类型定义放在独立的 `types.ts` 中
- 样式使用 Tailwind CSS 原子类，避免手写 CSS

### 工具定义

```typescript
// 使用 make() + Zod Schema
export const myTool = make({
  name: "my_tool",
  description: "What this tool does",
  inputSchema: z.object({
    path: z.string().describe("Path to file"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    // 实现
  },
})
```

### 提交信息

使用中文描述，格式：`<类型>: <简要说明>`

```
feat: 新增侧边栏自动折叠功能
fix: 修复消息编辑时 input 值未更新
refactor: 重构 sendMessage 参数传递
docs: 补充 CONTRIBUTING.md
chore: 清理构建产物和冗余文件
style: 优化空状态引导布局
```

## 分支管理

- `main` — 稳定发布分支
- `feat/*` — 功能开发
- `fix/*` — 问题修复
- `docs/*` — 文档改进

## PR 流程

1. 从 `main` 创建功能分支
2. 实现功能或修复问题
3. 运行 `pnpm typecheck` 确保类型正确
4. 运行 `pnpm build` 确保构建通过
5. 运行 `pnpm test` 确保测试通过
6. 创建 Pull Request

## 测试

```powershell
# 运行所有测试
pnpm test

# TypeScript 类型检查
pnpm typecheck

# 构建验证
pnpm build
```

## 目录结构

参见 `docs/architecture.md` 了解完整架构说明。

## 包结构

```
packages/
├── core/          # 核心逻辑（Agent/LLM/Tools/Memory）
├── electron/      # Electron 主进程
├── ui/            # React 前端组件
└── apps/desktop/  # Electron 应用壳
```
