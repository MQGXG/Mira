# OmniAgent UI/UX 全面重写设计文档

## 概述

对 OmniAgent 前端 UI 进行全面重写，采用玻璃拟态（Glassmorphism）风格 + 全新配色方案，提升视觉体验和交互流畅度。

## 配色系统

### 深色模式（主）

```css
--bg-primary:    #0c0c14    /* 主背景 */
--bg-secondary:  #141420    /* 次级背景 */
--bg-elevated:   #1a1a2e    /* 浮层背景 */
--glass-bg:      rgba(255,255,255,0.04)
--glass-border:  rgba(255,255,255,0.08)
--glass-blur:    16px
--accent-start: #6366f1    /* 靛蓝 */
--accent-end:   #06b6d4    /* 青 */
--success: #34d399
--warning: #fbbf24
--error:   #f43f5e
--text-primary:   #f1f5f9
--text-secondary: #94a3b8
--text-tertiary:  #64748b
```

### 浅色模式

```css
--bg-primary:    #f8fafc
--bg-secondary:  #f1f5f9
--glass-bg:      rgba(255,255,255,0.7)
--glass-border:  rgba(0,0,0,0.06)
--text-primary:   #0f172a
--text-secondary: #475569
```

## 组件设计

### 1. TitleBar
- 玻璃背景 backdrop-blur
- 渐变品牌名
- 状态指示灯脉冲动画
- 窗口控制 hover 效果

### 2. ProjectBar
- 玻璃面板
- 项目按钮渐变背景（每个项目不同色相）
- 选中项发光效果
- 右键菜单玻璃面板

### 3. Sidebar
- 玻璃背景
- 列表项选中态左侧渐变指示条
- 操作按钮悬停渐显
- 底部状态玻璃卡片

### 4. ChatWindow
- 消息气泡入场动画 (fadeInUp)
- 用户气泡渐变主色背景
- AI 气泡玻璃面板
- 拖拽遮罩玻璃效果

### 5. 弹窗体系
- 统一 Modal 组件
- 玻璃面板主体
- scale+fade 入场动画
- 渐变操作按钮

### 6. 共享组件
- GlassPanel、Modal、Toast、Skeleton、GradientButton

## 动画系统

- 消息: fadeInUp 200ms
- 弹窗: scale+fade 200ms
- Sidebar: 宽度过渡 250ms
- 按钮: hover scale 1.05

## 实施顺序

1. Tailwind 配置 + 全局 CSS 变量
2. 共享组件（GlassPanel、Modal 等）
3. TitleBar
4. ProjectBar + Sidebar
5. ChatWindow + ChatInput
6. 弹窗体系
7. 动画完善
8. 浅色模式适配
