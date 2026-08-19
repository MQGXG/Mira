# OmniAgent UI/UX 全面重写实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 全面重写 OmniAgent 前端 UI，采用玻璃拟态风格 + 蓝紫渐变全新配色

**Architecture:** 从底层向上逐层推进：先更新 Tailwind 配置和全局 CSS 变量，再构建共享组件体系，最后逐组件重写

**Tech Stack:** React 18 + TypeScript + Tailwind CSS + Lucide Icons

---

### Task 1: Tailwind 配置 + 全局 CSS

**Files:**
- Modify: `tailwind.config.js`
- Modify: `src/styles/globals.css`

**Step 1: 更新 Tailwind 配置**
更新 `tailwind.config.js`，添加新颜色、玻璃效果工具类

**Step 2: 更新全局 CSS**
在 `globals.css` 中添加 CSS 变量、玻璃面板工具类、动画关键帧

**Step 3: 验证**
确保应用启动后样式正确加载

---

### Task 2: 共享组件体系

**Files:**
- Create: `src/components/ui/GlassPanel.tsx`
- Create: `src/components/ui/Modal.tsx`
- Create: `src/components/ui/IconButton.tsx`
- Create: `src/components/ui/index.ts`

**Step 1: GlassPanel** - 基础玻璃面板容器
**Step 2: Modal** - 统一弹窗（玻璃背景 + backdrop-blur + 动画）
**Step 3: IconButton** - 统一图标按钮
**Step 4: 导出** - index.ts 统一导出

---

### Task 3: TitleBar 重写

**Files:**
- Modify: `src/components/layout/TitleBar.tsx`

**Step 1: 玻璃背景 + 渐变 Logo**
**Step 2: 状态指示灯 + 脉冲动画**
**Step 3: 窗口控制按钮样式**

---

### Task 4: ProjectBar 重写

**Files:**
- Modify: `src/components/sidebar/ProjectBar.tsx`

**Step 1: 玻璃面板化**
**Step 2: 渐变项目头像（HSL 色相分布）**
**Step 3: 选中发光效果**
**Step 4: 右键菜单玻璃化**

---

### Task 5: Sidebar 重写

**Files:**
- Modify: `src/components/sidebar/Sidebar.tsx`

**Step 1: 玻璃面板背景**
**Step 2: 列表项选中渐变指示条**
**Step 3: 动画过渡**
**Step 4: 底部状态卡片**

---

### Task 6: ChatWindow 重写

**Files:**
- Modify: `src/components/chat/ChatWindow.tsx`
- Modify: `src/components/chat/ChatInput.tsx`
- Modify: `src/components/chat/ModelSelector.tsx`
- Modify: `src/components/chat/ToolCallView.tsx`

**Step 1: 消息气泡 - 用户(渐变)/AI(玻璃)**
**Step 2: 消息入场动画**
**Step 3: 拖拽遮罩玻璃效果**
**Step 4: ChatInput 玻璃输入框**
**Step 5: ModelSelector 玻璃化**
**Step 6: ToolCallView 玻璃卡片**

---

### Task 7: 弹窗体系重写

**Files:**
- Modify: `src/components/chat/PermissionDialog.tsx`
- Modify: `src/components/chat/QuestionDialog.tsx`
- Modify: `src/components/sidebar/NewProjectDialog.tsx`
- Modify: `src/components/sidebar/EditProjectDialog.tsx`
- Modify: `src/components/sidebar/NewTaskDialog.tsx`
- Modify: `src/components/sidebar/SettingsDialog.tsx`
- Modify: `src/components/sidebar/ProviderConfigPanel.tsx`
- Modify: `src/components/sidebar/ModelManager.tsx`

全部改用统一的 Modal 组件和玻璃风格

---

### Task 8: 浅色模式适配 + 收尾

**Files:**
- Modify: `tailwind.config.js` (light mode colors)
- Modify: `src/styles/globals.css` (light mode variables)
- Verify all components

确保浅色模式下所有玻璃效果、颜色、动画正常工作
