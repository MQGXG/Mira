/**
 * Cron 调度器 — 解析 cron 表达式并定时执行任务
 * 零外部依赖，替代 Python cron_scheduler
 */

import { backgroundNotifier, setBackgroundNotifier } from "./index"

export type CronTask = {
  id: string
  expression: string
  description: string
  lastRun: number
  nextRun: number
  enabled: boolean
}

/** 内部任务（含 handler，不对外暴露） */
type CronTaskInternal = CronTask & { handler: () => Promise<void> }

/** 简易 cron 表达式解析（支持分 时 日 月 周） */
function parseCron(expr: string): { minute: number[]; hour: number[]; dayOfMonth: number[]; month: number[]; dayOfWeek: number[] } {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Cron 表达式需要 5 个字段，收到 ${parts.length}: "${expr}"`)

  function parseField(field: string, min: number, max: number): number[] {
    const values = new Set<number>()
    for (const seg of field.split(",")) {
      if (seg === "*") { for (let i = min; i <= max; i++) values.add(i); continue }
      const match = seg.match(/^(\d+)(?:-(\d+))?(?:\/(\d+))?$/)
      if (!match) throw new Error(`无法解析 cron 字段: "${seg}"`)
      const start = parseInt(match[1])
      const end = match[2] ? parseInt(match[2]) : start
      const step = match[3] ? parseInt(match[3]) : 1
      for (let i = start; i <= end; i += step) values.add(i)
    }
    return Array.from(values).filter((v) => v >= min && v <= max)
  }

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  }
}

function nextCronTime(expr: { minute: number[]; hour: number[]; dayOfMonth: number[]; month: number[]; dayOfWeek: number[] }, from: Date = new Date()): number {
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)

  for (let yearOffset = 0; yearOffset < 5; yearOffset++) {
    const year = candidate.getFullYear() + yearOffset
    for (const month of expr.month) {
      if (year === candidate.getFullYear() && month < candidate.getMonth() + 1) continue
      const daysInMonth = new Date(year, month, 0).getDate()
      for (const day of expr.dayOfMonth) {
        if (day > daysInMonth) continue
        if (year === candidate.getFullYear() && month === candidate.getMonth() + 1 && day < candidate.getDate()) continue
        const dow = new Date(year, month - 1, day).getDay()
        if (!expr.dayOfWeek.includes(dow)) continue
        for (const hour of expr.hour) {
          if (year === candidate.getFullYear() && month === candidate.getMonth() + 1 && day === candidate.getDate() && hour < candidate.getHours()) continue
          for (const minute of expr.minute) {
            if (year === candidate.getFullYear() && month === candidate.getMonth() + 1 && day === candidate.getDate() && hour === candidate.getHours() && minute <= candidate.getMinutes()) continue
            return new Date(year, month - 1, day, hour, minute, 0).getTime()
          }
        }
      }
    }
  }
  return 0
}

export class CronScheduler {
  private tasks = new Map<string, CronTaskInternal>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  /** 注册一个定时任务 */
  add(id: string, expression: string, description: string, handler: () => Promise<void>): void {
    const parsed = parseCron(expression)
    const now = Date.now()
    this.tasks.set(id, {
      id, expression, description, handler,
      lastRun: 0,
      nextRun: nextCronTime(parsed),
      enabled: true,
    })
  }

  /** 移除定时任务 */
  remove(id: string): void {
    this.tasks.delete(id)
  }

  /** 列出所有任务（公开视图，不含 handler） */
  list(): CronTask[] {
    return Array.from(this.tasks.values()).map(({ handler, ...rest }) => rest)
  }

  /** 启动调度器 */
  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.tick(), 1000)
  }

  /** 停止调度器 */
  stop(): void {
    this.running = false
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private tick(): void {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue
      if (task.nextRun <= now) {
        task.lastRun = now
        task.handler().then(
          () => {
            try {
              const { backgroundNotifier } = require("./index") as typeof import("./index")
              backgroundNotifier?.addTaskResult("completed", task.description || task.id)
            } catch { /* notifier 未配置/模块未加载时静默 */ }
          },
          (err: Error) => {
            try {
              const { backgroundNotifier } = require("./index") as typeof import("./index")
              backgroundNotifier?.addTaskResult("failed", task.description || task.id, err?.message)
            } catch { /* 同上 */ }
          },
        )
        // 计算下一次运行时间
        const parsed = parseCron(task.expression)
        task.nextRun = nextCronTime(parsed, new Date(now + 60000))
      }
    }
  }
}

export const cronScheduler = new CronScheduler()
