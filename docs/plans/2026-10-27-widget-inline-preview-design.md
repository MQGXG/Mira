# Widget 内嵌预览完整复刻设计（复制 WorkBuddy 效果）

日期：2026-10-27
状态：已批准并实施完成（typecheck / UI 测试 90 用例 / electron-vite build 全部通过）

## 背景与目标

参考他人产品的对话内可视化效果（截图见会话记录）：
LLM 输出的 HTML/SVG 在聊天中以「组件卡片」呈现，右上角悬浮工具栏，
渲染图与代码**在同一容器内切换**（而非上下堆叠），
支持复制为图片 / 保存为图片 / 添加到对话 / 下载到本地。

Mira 现状：
- ` ```html `/` ```widget ` 由 `extractWidgetBlocks` 提取为 widget part，经 `WidgetRenderer`（iframe 沙箱）渲染；「查看代码」是**下方追加**。
- ` ```svg ` 由 `inlineSvgBlocks`（markdown 预处理）转为「代码块 + 内嵌 img」，同样两段。

## 设计

### 1. 提取层（widget-utils.ts）
- `extractWidgetBlocks` 支持 `html/widget/svg`，返回项增加 `lang: "html" | "svg"`。
- 仍要求代码块闭合（流式安全）；未闭合保持代码显示。
- widget part 增加可选 `lang` 字段；历史消息无 `lang` 按 html 处理（不迁移数据）。
- `inlineSvgBlocks` 保留为兜底（工具输出等非 assistant 提取路径）。

### 2. 渲染层（widget-renderer.tsx 重构为卡片）
- 单容器双视图 `view: preview | code`，切换替换内容，不追加。
- 预览：html → iframe 沙箱（现有高度上报 + chart.js 本地注入）；svg → `data:` URL `<img>`。
- 代码：`<pre>`，容器沿用预览高度，内部滚动。
- 右上角悬浮工具栏（常驻半透明，hover 变实）：
  - 添加到对话（`onAddToChat?: (code: string) => void`，由 ChatWindow 提供实现）
  - 下载到本地（html → .html；svg → .svg）
  - `⋯` 菜单：复制为图片 / 保存为图片 / 复制代码 / 查看代码·预览切换

### 3. 图片导出
- svg：canvas 绘制（2x）→ PNG。
- html：iframe 内注入 html2canvas（?raw 离线内联）→ dataURL postMessage 回传 → 复制/保存。
- 图片导出背景跟随当前主题底色。

### 4. 添加到对话
- assistant-ui ExternalStore 的 composer 无 setQuote（已验证），
  用 `useThreadRuntime().composer`：`setText(prev + "```html\n…\n```")`（追加，不覆盖）。
- 经 `onAddToChat` 回调注入，WidgetRenderer 不直接依赖 runtime（widget-test 无 runtime 环境可复用）。

### 5. 主题适配
- `useTheme().resolvedTheme` → 注入 iframe `color-scheme` 与 `--mira-bg/--mira-fg`，
  body 背景跟随主题；不覆盖组件自带配色。

### 6. 风险
| 风险 | 处理 |
|---|---|
| html2canvas 保真度 | 先实现；不满足再换 Electron capturePage |
| iframe 无 same-origin | 全走 postMessage（已有机制） |
| 流式重建 iframe 闪烁 | 闭合后才提取渲染 |
| 代码/预览高度不一致跳动 | 代码视图沿用预览高度内部滚动 |

### 7. 验证
- 单测：提取（html/svg/widget/未闭合/混合）。
- 手工：svg 流程图、Chart.js 柱状图、交互组件、深浅主题、复制/保存图片、添加到对话。
- 打包后离线验证（CDN 移除、本地注入生效）。

## 涉及文件
- `packages/ui/src/components/assistant-ui/widget-utils.ts`
- `packages/ui/src/components/assistant-ui/widget-renderer.tsx`
- `packages/ui/src/chat/types-message.ts`（MiraPart.lang）
- `packages/ui/src/hooks/stream-events.ts` / `session-runtime-store.ts`
- `packages/ui/src/chat/ChatWindow.tsx`
- `packages/ui/src/components/assistant-ui/widget-test-main.tsx`
- `packages/ui/src/components/assistant-ui/widget-utils.test.ts`
- `package.json`（新增 html2canvas）
