/**
 * 后台任务系统 — 异步执行长时间运行的操作
 * 替代 Python background.py
 */

import { randomUUID } from "crypto"

export * from "./notifier"

export type BackgroundStatus = "queued" | "running" | "done" | "failed"

export interface BackgroundTask {
  id: string
  name: string
  status: BackgroundStatus
  startedAt: number
  completedAt: number
  result: string
  error: string
  progress: number  // 0-100
}

const tasks = new Map<string, BackgroundTask>()
const handlers = new Map<string, () => Promise<string>>()
/** 全局后台播报器（cron/后台任务完成时投递；可注入 AnnouncementWindow 进行插话门控） */
export let backgroundNotifier: import("./notifier").BackgroundNotifier | null = null

export function setBackgroundNotifier(notifier: import("./notifier").BackgroundNotifier | null): void {
  backgroundNotifier = notifier
}

/** 判断是否为慢操作（需要后台执行） */
export function isSlowOperation(command: string): boolean {
  const slowPatterns = [
    "install", "build", "compile", "test", "deploy",
    "npm install", "pip install", "git clone",
    "docker build", "docker pull",
    "npx create", "yarn install",
  ]
  const lower = command.toLowerCase()
  return slowPatterns.some((p) => lower.includes(p))
}

/** 注册并启动后台任务 */
export function startBackground(name: string, handler: () => Promise<string>): string {
  const id = `bg-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const task: BackgroundTask = {
    id, name, status: "queued",
    startedAt: 0, completedAt: 0,
    result: "", error: "", progress: 0,
  }
  tasks.set(id, task)
  handlers.set(id, handler)

  // 异步执行
  Promise.resolve().then(async () => {
    task.status = "running"
    task.startedAt = Date.now()
    try {
      task.result = await handler()
      task.status = "done"
      task.progress = 100
    } catch (e) {
      task.error = e instanceof Error ? e.message : String(e)
      task.status = "failed"
    }
    task.completedAt = Date.now()
    handlers.delete(id)
    // 完成后播报（安全窗口门控由 notifier 处理）
    backgroundNotifier?.addTaskResult(
      task.status === "done" ? "completed" : "failed",
      task.name,
      task.status === "done" ? task.result?.slice(0, 200) : task.error?.slice(0, 200),
    )
  })

  return id
}

/** 获取任务状态 */
export function getTaskStatus(id: string): BackgroundTask | undefined {
  return tasks.get(id)
}

/** 列出所有后台任务 */
export function listBackgroundTasks(): BackgroundTask[] {
  return Array.from(tasks.values())
}

/** 清理已完成的任务 */
export function cleanupBackgroundTasks(olderThanMs = 300000): void {
  const cutoff = Date.now() - olderThanMs
  for (const [id, task] of tasks) {
    if (task.completedAt > 0 && task.completedAt < cutoff) {
      tasks.delete(id)
    }
  }
}

/** 等待任务完成 */
export async function waitForTask(id: string, timeoutMs = 120000): Promise<BackgroundTask> {
  const task = tasks.get(id)
  if (!task) throw new Error(`Task not found: ${id}`)
  if (task.status === "done" || task.status === "failed") return task

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const current = tasks.get(id)
    if (!current) throw new Error(`Task disappeared: ${id}`)
    if (current.status === "done" || current.status === "failed") return current
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Task ${id} timed out after ${timeoutMs}ms`)
}
