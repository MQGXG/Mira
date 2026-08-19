/**
 * 轻量事件发射器（纯 TS，无 Node 依赖）
 *
 * voice-session 使用它以便 @mira/core/voice 可在渲染进程 import
 * （Node `events` 在浏览器 bundle 中不可用）。
 */

type Listener = (...args: unknown[]) => void

export class LightEmitter {
  private listeners = new Map<string, Set<Listener>>()

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn)
    return this
  }

  off(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of Array.from(set)) {
      try {
        fn(...args)
      } catch { /* 单个监听器异常不影响其余 */ }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }
}