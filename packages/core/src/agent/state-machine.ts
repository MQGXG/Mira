export type PermissionReply = "allow" | "deny" | "always"

export type AgentState = "idle" | "running" | "waiting_permission" | "stopped" | "done"

/** 对外双态视图（对齐 dsh AgentStatus）：内部 waiting_permission/stopped/done 收敛为 idle */
export type AgentStatus = "idle" | "running"

interface StateTransition {
  from: AgentState[]
  to: AgentState
  guard?: () => boolean
}

const TRANSITIONS: StateTransition[] = [
  { from: ["idle"],                                                to: "running" },
  { from: ["idle", "running", "waiting_permission", "stopped"],   to: "stopped" },
  { from: ["running"],                                             to: "waiting_permission" },
  { from: ["waiting_permission"],                                  to: "running" },
  { from: ["running", "waiting_permission"],                       to: "done" },
]

type StateChangeListener = (prev: AgentState, next: AgentState) => void
type StatusChangeListener = (status: AgentStatus) => void

/** 内部状态 → 对外双态映射：waiting_permission/stopped/done 均收敛为 idle */
function toStatus(state: AgentState): AgentStatus {
  return state === "running" || state === "waiting_permission" ? "running" : "idle"
}

export class AgentStateMachine {
  private _state: AgentState = "idle"
  private _finalized = false
  private listeners = new Set<StateChangeListener>()
  private statusListeners = new Set<StatusChangeListener>()

  get state(): AgentState { return this._state }
  get status(): AgentStatus { return toStatus(this._state) }
  get aborted(): boolean { return this._state === "stopped" }

  subscribe(listener: StateChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 订阅对外双态变化（idle ⇄ running），返回 disposer */
  subscribeStatus(listener: StatusChangeListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private transitionTo(next: AgentState): boolean {
    const rule = TRANSITIONS.find(t => t.to === next && t.from.includes(this._state))
    if (!rule) throw new Error(`Invalid state transition: ${this._state} → ${next}`)
    if (rule.guard && !rule.guard()) return false
    const prev = this._state
    const prevStatus = toStatus(prev)
    this._state = next
    if (next === "stopped" || next === "done") this._finalized = true
    for (const fn of this.listeners) fn(prev, next)
    const nextStatus = toStatus(next)
    if (prevStatus !== nextStatus) {
      for (const fn of this.statusListeners) fn(nextStatus)
    }
    return true
  }

  start(): void { this.transitionTo("running") }
  waitPermission(): void { this.transitionTo("waiting_permission") }
  stop(): void { this.transitionTo("stopped") }
  finish(): void { this.transitionTo("done") }

  private pendingPermissions = new Map<string, {
    resolve: (allow: boolean) => void
    onAlways?: () => void
  }>()

  replyPermission(id: string, reply: PermissionReply): boolean {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return false
    this.pendingPermissions.delete(id)
    if (reply === "deny") {
      pending.resolve(false)
    } else {
      pending.resolve(true)
      if (reply === "always") pending.onAlways?.()
    }
    return true
  }

  createPermissionRequest(onAlways?: () => void): { id: string; waitForReply(this: void): Promise<boolean> } {
    const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`
    let resolve!: (allow: boolean) => void
    const promise = new Promise<boolean>((r) => { resolve = r })
    this.pendingPermissions.set(id, { resolve, onAlways })
    return {
      id,
      waitForReply: () => promise,
    }
  }
}
