/**
 * 桌宠动作插件管理器 — 为 Live2D 桌宠提供可插拔的动作/表情系统
 *
 * 参考 airi `packages/stage-ui-live2d/src/composables/live2d/motion-manager.ts`（插件式
 * 注册 + 每帧 Update ctx），按 Mira 的轻量需求简化：
 * - ActionPlugin { name, kind, idle, trigger?, update? }
 * - trigger(action) 命中 kind 的插件成为 active；空闲期则逐帧驱动 idle 插件
 * - 动作按 durationMs 自动回归 idle，offset/ease 曲线驱动参数
 *
 * 纯 TS 零依赖，可单测。
 */

export type MotionKind =
  | "wave"
  | "nod"
  | "shake"
  | "joy"
  | "sad"
  | "surprise"
  | "angry"
  | "think"
  | "incoming"
  | "custom"

export interface MotionAction {
  kind: MotionKind | string
  /** 强度 0..1，默认 1 */
  intensity?: number
  /** 时长（ms）；0 = 直到 stop() 手动结束 */
  durationMs?: number
  /** 纵跳/幅度等扩展载荷 */
  payload?: Record<string, unknown>
}

export interface MotionContext {
  /** 精确秒 */
  now: number
  /** 帧间隔（秒） */
  delta: number
  /** 当前 active 动作（无则 null） */
  action: MotionAction | null
  /** 写模型参数；未 map 的参数名会被忽略 */
  setParameter(name: string, value: number): void
}

export interface ActionPlugin {
  /** 全局唯一名 */
  name: string
  /** 匹配的 kind；不设 = 兜底匹配所有 */
  kind?: string
  /** 空闲期（无 active 动作）是否逐帧驱动；默认 true */
  idle?: boolean
  /** 插件常驻 set 入口：receive(parameter, value) 或主动覆盖 */
  trigger?(action: MotionAction, ctx: MotionContext): void
  /** 动作回归 idle 或插件被替换时调用 */
  update?(ctx: MotionContext): void
}

/** 参数映射槽：插件把归一值写进来，外部 rAF 负责 apply 到模型 */
export type ParameterSink = (name: string, value: number) => void

export interface PetMotionManagerOptions {
  /** idle 帧最小间隔（ms），默认 0（每帧都跑） */
  idleIntervalMs?: number
}

export class PetMotionManager {
  private plugins: ActionPlugin[] = []
  private sink: ParameterSink = () => {}
  private activePlugin: ActionPlugin | null = null
  private activeAction: MotionAction | null = null
  private activeElapsed = 0
  private totalMs = 0
  private lastIdleMs = 0

  constructor(private readonly opts: PetMotionManagerOptions = {}) {}

  /** 绑定参数写入器 */
  setSink(sink: ParameterSink): this {
    this.sink = sink
    return this
  }

  register(plugin: ActionPlugin): this {
    if (!this.plugins.some((p) => p.name === plugin.name)) this.plugins.push(plugin)
    return this
  }

  unregister(name: string): void {
    this.plugins = this.plugins.filter((p) => p.name !== name)
    if (this.activePlugin?.name === name) this.stop()
  }

  list(): string[] {
    return this.plugins.map((p) => p.name)
  }

  /** 触发动作；已有 active 则替换 */
  trigger(action: MotionAction): void {
    const matched = this.plugins.find((p) => !p.kind || p.kind === action.kind)
    this.activePlugin = matched ?? null
    this.activeAction = matched ? action : null
    this.activeElapsed = 0
    if (matched) matched.trigger?.(action, this.ctx(0, action))
  }

  /** 主动结束（回到 idle 管线） */
  stop(): void {
    this.stopActive()
  }

  get active(): MotionAction | null {
    return this.activeAction
  }

  /** 推进一帧 */
  update(deltaSec: number): void {
    const deltaMs = Math.round(deltaSec * 1000)
    this.totalMs += deltaMs

    if (this.activePlugin && this.activeAction) {
      const dur = this.activeAction.durationMs ?? 0
      if (dur > 0 && this.activeElapsed >= dur) {
        this.stopActive()
      } else {
        this.activeElapsed += deltaMs
        this.activePlugin.update?.(this.ctx(deltaMs / 1000, this.activeAction))
        return
      }
    }

    if (this.totalMs - this.lastIdleMs < (this.opts.idleIntervalMs ?? 0)) return
    this.lastIdleMs = this.totalMs
    const idleCtx = this.ctx(deltaMs / 1000, null)
    for (const plugin of this.plugins) {
      if (plugin.idle === false) continue
      plugin.update?.(idleCtx)
    }
  }

  /** 将"模型刚加载"参数刷新回模型（插件可用于初始化表情值） */
  frameInit(): void {
    for (const plugin of this.plugins) plugin.update?.(this.ctx(0, null))
  }

  private stopActive(): void {
    this.activePlugin = null
    this.activeAction = null
    this.activeElapsed = 0
  }

  private ctx(deltaSec: number, action: MotionAction | null): MotionContext {
    return {
      now: this.totalMs / 1000,
      delta: deltaSec,
      action,
      setParameter: this.sink,
    }
  }
}

/** 简单插值工具：按 delta 把 value 移向 target（指数平滑） */
export function approach(current: number, target: number, rate: number, delta: number): number {
  return current + (target - current) * Math.min(1, rate * delta)
}