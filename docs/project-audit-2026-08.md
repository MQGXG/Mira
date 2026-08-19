# Mira 项目审计与清理记录

日期：2026-08-19

## 项目判断

Mira 是 Electron + React + TypeScript Agent Core 桌面应用。实际运行链路为：

```text
React UI -> preload IPC -> Electron IPC -> Core HTTP sidecar -> Agent -> LLM Provider
```

根目录的 `electron.vite.config.ts` 是完整启动配置，包含主进程、preload、renderer、sidecar、桌宠和 Widget 多入口。`apps/desktop` 仍是独立 workspace package，因此其配置文件不能视为无用文件直接删除。

## 本次修复

### 1. 修复 sidecar 启动失败被吞掉

文件：`packages/electron/src/main/index.ts`

此前 `startSidecar()` 的异常被转换成已完成的 Promise，主窗口仍会继续启动并打印“Core Sidecar server ready”。现在启动失败会：

1. 记录真实错误；
2. 弹出 Electron 错误对话框；
3. 退出应用，避免进入表面可用但所有 IPC 请求失败的状态。

### 2. 移除历史死 API

文件：

- `packages/electron/src/preload/index.ts`
- `packages/ui/src/types/electron.d.ts`

移除了没有对应 IPC handler 的 Python API、`agent.chat` 和 `runAgentStream`，并删除了只服务于 Python 日志 API 的 `LogEntry` 类型。

### 3. 收窄 Tailwind 扫描范围

文件：`tailwind.config.js`

将扫描范围限制到 `packages/**/src` 和 `apps/**/src`，避免把整个 package 目录及潜在的 `node_modules` 扫入 Tailwind 内容扫描。

## 清理内容

已删除以下可重新生成的构建产物：

- `dist/`
- `dist-electron/`

以下目录没有删除，因为它们可能包含用户数据、运行状态或本地依赖：

- `data/`
- `memory/`
- `vector-memory/`
- `checkpoints/`
- `tasks/`
- `graphs/`
- `logs/`
- `lsp/`
- `node_modules/`

## 验证结果

- `corepack pnpm typecheck`：通过
- `corepack pnpm test`：84 个测试文件通过，759 个测试通过，2 个文件跳过
- `corepack pnpm exec electron-vite dev`：主进程、preload、renderer 和 sidecar 均成功启动
- Sidecar `/api/health`：通过

## 仍需后续处理的问题

1. 根目录和 `apps/desktop` 保留两套 Electron/Vite 配置，后续应明确唯一官方入口或让两者共享配置。
2. Sidecar 的 HTTP `ready` 仍早于数据库初始化完成，建议增加独立 readiness 状态。
3. 动态记忆管理器仍是模块级可变单例，多会话并发时需要改为按 session/workspace 注入。
4. Electron IPC、sidecar spawn、SSE、重连和生产构建启动仍缺少端到端测试。
5. 构建仍会报告动态导入与静态导入混用警告，API bundle 体积约 2.8 MB，可作为性能优化项处理。
6. Node 仍报告 `url.parse()` 弃用警告，建议迁移到 WHATWG `URL` API。

## 启动性能优化

日期：2026-08-19

针对开发启动慢的问题又完成了以下调整：

1. 移除根 `package.json` 的 `predev` 安装钩子。依赖安装改为显式执行，避免每次启动都触发 `pnpm install`。
2. 将 `GraphPanel` 改为 `React.lazy` 按需加载。构建结果已生成独立的 `GraphPanel-*.js` chunk，不再阻塞首屏主 bundle。
3. 启动遮罩改为首帧后结束，项目列表查询与 sidecar/数据库初始化并行进行，不再让首屏等待 `listProjects()`。

实测构建仍需约 7 秒，这是开发模式主进程编译 Core 的成本；运行时的 3D 图谱和项目数据初始化已从首屏路径移开。