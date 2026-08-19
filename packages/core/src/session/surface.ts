/**
 * Surface 折叠层 — 事件日志之上的模型可见消息视图（对齐 dsh surface 语义简化移植）
 *
 * 事件日志保持只追加（事实源）；surface 是日志中产生 LLM 消息的节点的有序视图。
 * append 事件（message.appended）追加到 surface 尾；replace 事件（message.replaced）
 * 折叠（替换）一段已存在范围 —— 即"替换旧消息而非追加"。
 *
 * Mira 命名风格：判别函数 isAppendSurfaceEvent / isReplacementSurfaceEvent、
 * foldSurface / SurfaceManager 与 dsh 对齐（签名/结构一致），事件名走 Mira 模型
 * （message.appended / message.replaced）。
 */

import type { SessionEvent } from "./event-types"

/** 产生模型可见消息的事件类型集合 */
const SURFACE_EVENT_TYPES = new Set<string>(["message.appended", "message.replaced"])

/** 事件类型是否可进入模型可见 surface */
export function isSurfaceEligibleType(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/** 事件是否为 append 来源的 surface 事件 */
export function isAppendSurfaceEvent(event: SessionEvent): boolean {
  return event.type === "message.appended"
}

/** 事件是否为 surface 替换（折叠旧范围） */
export function isReplacementSurfaceEvent(event: SessionEvent): boolean {
  return event.type === "message.replaced"
}

/** 一次替换操作观察到的信息 */
export interface SurfaceFoldReplacement {
  /** 发起替换的事件 seq */
  seq: number
  /** 被替换的包含起始 seq */
  start: number
  /** 被替换的包含结束 seq */
  end: number
  /** 实际被移除的 surface 节点 seq，按 surface 序 */
  shadowedSeqs: number[]
}

/** 折叠完整日志的结果 */
export interface SurfaceFoldResult {
  /** 当前 surface 消息 seq（模型可见序） */
  nodes: number[]
  /** 按事件序的替换操作 */
  replacements: SurfaceFoldReplacement[]
}

interface SurfaceFoldState {
  nodes: number[]
  replaceGeneration: number
}

function createFoldState(): SurfaceFoldState {
  return { nodes: [], replaceGeneration: 0 }
}

/** 解析一次 surface 操作（append 或 replace{start,end}），非法返回 undefined */
function surfaceOpOf(event: SessionEvent): "append" | { start: number; end: number } | undefined {
  if (event.type === "message.appended") return "append"
  if (event.type === "message.replaced") {
    return { start: event.payload.replaces.start, end: event.payload.replaces.end }
  }
  return undefined
}

/** 定位替换范围（不改变折叠状态） */
function replacementRange(
  state: SurfaceFoldState,
  op: { start: number; end: number },
): { startIdx: number; endIdx: number; shadowedSeqs: number[] } {
  const startIdx = state.nodes.indexOf(op.start)
  if (startIdx === -1) throw new Error(`surface replace: start seq ${op.start} not found in surface`)
  const endIdx = state.nodes.indexOf(op.end)
  if (endIdx === -1) throw new Error(`surface replace: end seq ${op.end} not found in surface`)
  if (startIdx > endIdx) throw new Error(`surface replace: start ${op.start} is after end ${op.end}`)
  return { startIdx, endIdx, shadowedSeqs: state.nodes.slice(startIdx, endIdx + 1) }
}

/** 折叠一个事件（原子过渡）；替换时返回替换元数据 */
function applySurfaceEvent(
  state: SurfaceFoldState,
  event: SessionEvent,
): SurfaceFoldReplacement | undefined {
  const op = surfaceOpOf(event)
  if (op === undefined) return undefined
  if (op === "append") {
    state.nodes.push(event.seq)
    return undefined
  }
  const range = replacementRange(state, op)
  state.nodes.splice(range.startIdx, range.endIdx - range.startIdx + 1, event.seq)
  state.replaceGeneration += 1
  return { seq: event.seq, start: op.start, end: op.end, shadowedSeqs: range.shadowedSeqs }
}

/**
 * 重放完整日志经 canonical surface 折叠。
 * @param events - 按 seq 连续排列的会话事件。
 * @returns 当前节点 seq + 替换历史。
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceFoldResult {
  const state = createFoldState()
  const replacements: SurfaceFoldReplacement[] = []
  for (const event of events) {
    const replacement = applySurfaceEvent(state, event)
    if (replacement !== undefined) replacements.push(replacement)
  }
  return { nodes: [...state.nodes], replacements }
}

/** 增量有序 surface 视图（append-boundary validator） */
export class SurfaceManager {
  private state = createFoldState()
  private lastProcessedSeq: number

  constructor(
    private log: readonly SessionEvent[],
    private readonly baseSeq = 0,
  ) {
    this.lastProcessedSeq = baseSeq - 1
  }

  /** 折叠的替换计数（单调） */
  get replaceGeneration(): number {
    this.processDelta()
    return this.state.replaceGeneration
  }

  /** surface 事件 seq（模型可见序） */
  get nodes(): readonly number[] {
    this.processDelta()
    return this.state.nodes
  }

  /** 折叠自上次访问以来追加的事件 */
  private processDelta(): void {
    const tailSeq = this.baseSeq + this.log.length - 1
    for (let seq = this.lastProcessedSeq + 1; seq <= tailSeq; seq++) {
      const event = this.log[seq - this.baseSeq]
      if (event !== undefined) applySurfaceEvent(this.state, event)
      this.lastProcessedSeq = seq
    }
  }
}
