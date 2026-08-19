/**
 * Feature Flag 系统 — 参考 Claude Code 的 feature flag 机制
 * 控制功能的启停，支持运行时切换
 */

export interface FeatureFlag {
  name: string
  description: string
  enabled: boolean
  defaultValue: boolean
}

// 默认 Feature Flags
const defaultFlags: Record<string, FeatureFlag> = {
  // 工具相关
  "parallel-tools": {
    name: "parallel-tools",
    description: "启用工具并行执行",
    enabled: true,
    defaultValue: true,
  },
  "auto-accept-permissions": {
    name: "auto-accept-permissions",
    description: "自动接受权限请求",
    enabled: false,
    defaultValue: false,
  },
  "text-ngram-detection": {
    name: "text-ngram-detection",
    description: "启用文本重复检测",
    enabled: true,
    defaultValue: true,
  },

  // 运行时契约校验（对齐 dsh invariant），默认关闭避免性能开销
  "invariants": {
    name: "invariants",
    description: "启用运行时 invariant 校验（事件/数据关系一致性）",
    enabled: false,
    defaultValue: false,
  },

  // 记忆相关
  "memory-search": {
    name: "memory-search",
    description: "启用记忆搜索功能",
    enabled: true,
    defaultValue: true,
  },
  "dream-distill": {
    name: "dream-distill",
    description: "启用 Dream/Distill 记忆进化",
    enabled: true,
    defaultValue: true,
  },

  // Agent 相关
  "max-mode": {
    name: "max-mode",
    description: "启用 Max Mode 并行采样",
    enabled: false,
    defaultValue: false,
  },
  "goal-judge": {
    name: "goal-judge",
    description: "启用 Goal 完成度验证",
    enabled: true,
    defaultValue: true,
  },
  "subagent": {
    name: "subagent",
    description: "启用子 Agent 功能",
    enabled: true,
    defaultValue: true,
  },

  // 工作流相关
  "dynamic-workflow": {
    name: "dynamic-workflow",
    description: "启用 Dynamic Workflow 编排",
    enabled: true,
    defaultValue: true,
  },
  "mcp": {
    name: "mcp",
    description: "启用 MCP 协议支持",
    enabled: true,
    defaultValue: true,
  },

  // UI 相关
  "thinking-block": {
    name: "thinking-block",
    description: "显示思考过程",
    enabled: true,
    defaultValue: true,
  },
  "tool-palette": {
    name: "tool-palette",
    description: "启用工具面板",
    enabled: true,
    defaultValue: true,
  },
}

class FeatureFlagManager {
  private flags: Map<string, FeatureFlag> = new Map()
  private listeners: Map<string, Array<(enabled: boolean) => void>> = new Map()

  constructor() {
    // 初始化默认 flags
    for (const [key, flag] of Object.entries(defaultFlags)) {
      this.flags.set(key, { ...flag })
    }
    // 从 localStorage 加载持久化状态
    this.loadFromStorage()
  }

  /**
   * 检查 feature 是否启用
   */
  isEnabled(name: string): boolean {
    const flag = this.flags.get(name)
    if (!flag) return false
    return flag.enabled
  }

  /**
   * 启用 feature
   */
  enable(name: string): void {
    const flag = this.flags.get(name)
    if (flag) {
      flag.enabled = true
      this.saveToStorage()
      this.notifyListeners(name, true)
    }
  }

  /**
   * 禁用 feature
   */
  disable(name: string): void {
    const flag = this.flags.get(name)
    if (flag) {
      flag.enabled = false
      this.saveToStorage()
      this.notifyListeners(name, false)
    }
  }

  /**
   * 切换 feature 状态
   */
  toggle(name: string): void {
    if (this.isEnabled(name)) {
      this.disable(name)
    } else {
      this.enable(name)
    }
  }

  /**
   * 获取所有 flags
   */
  getAll(): FeatureFlag[] {
    return Array.from(this.flags.values())
  }

  /**
   * 获取单个 flag 信息
   */
  get(name: string): FeatureFlag | undefined {
    return this.flags.get(name)
  }

  /**
   * 监听 flag 变化
   */
  on(name: string, callback: (enabled: boolean) => void): () => void {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, [])
    }
    this.listeners.get(name)!.push(callback)
    return () => {
      const list = this.listeners.get(name)
      if (list) {
        const idx = list.indexOf(callback)
        if (idx >= 0) list.splice(idx, 1)
      }
    }
  }

  private notifyListeners(name: string, enabled: boolean): void {
    const list = this.listeners.get(name)
    if (list) {
      for (const cb of list) {
        try { cb(enabled) } catch { /* ignore */ }
      }
    }
  }

  private loadFromStorage(): void {
    try {
      if (typeof localStorage === "undefined") return
      const saved = localStorage.getItem("feature-flags")
      if (saved) {
        const data = JSON.parse(saved) as Record<string, unknown>
        for (const [key, enabled] of Object.entries(data)) {
          const flag = this.flags.get(key)
          if (flag) flag.enabled = enabled as boolean
        }
      }
    } catch { /* localStorage 在 Node.js 中不可用，使用默认值 */ }
  }

  private saveToStorage(): void {
    try {
      if (typeof localStorage === "undefined") return
      const data: Record<string, boolean> = {}
      for (const [key, flag] of this.flags) {
        data[key] = flag.enabled
      }
      localStorage.setItem("feature-flags", JSON.stringify(data))
    } catch { /* localStorage 在 Node.js 中不可用 */ }
  }
}

// 全局单例
export const featureFlags = new FeatureFlagManager()

/**
 * 快捷函数：检查 feature 是否启用
 */
export function isFeatureEnabled(name: string): boolean {
  return featureFlags.isEnabled(name)
}
