/**
 * Task Tracker — 树形任务管理系统
 * 参考 MiMo-Code 的 T1, T1.1, T1.2 任务树
 */

import { join } from "path"
import fs from "fs"
import { randomUUID } from "crypto"
import { getPlatformPaths } from "../config/paths"

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "abandoned"

export interface Task {
  id: string
  parentId: string | null
  summary: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  children: Task[]
  notes: string[]
}

interface TaskStore {
  tasks: Task[]
}

export class TaskTracker {
  private storePath = ""
  private store: TaskStore = { tasks: [] }

  async initialize(sessionId: string): Promise<void> {
    const dir = join(getPlatformPaths().userData, "tasks", sessionId)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    this.storePath = join(dir, "tasks.json")
    this.loadStore()
  }

  /** 创建新任务 */
  create(summary: string, parentId?: string): Task {
    const task: Task = {
      id: `T${Date.now().toString(36)}`,
      parentId: parentId || null,
      summary,
      status: "open",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: [],
      notes: [],
    }

    if (parentId) {
      const parent = this.findTask(this.store.tasks, parentId)
      if (parent) {
        parent.children.push(task)
      } else {
        this.store.tasks.push(task)
      }
    } else {
      this.store.tasks.push(task)
    }

    this.saveStore()
    return task
  }

  /** 更新任务状态 */
  updateStatus(taskId: string, status: TaskStatus): boolean {
    const task = this.findTask(this.store.tasks, taskId)
    if (!task) return false
    task.status = status
    task.updatedAt = new Date().toISOString()
    this.saveStore()
    return true
  }

  /** 更新任务摘要 */
  updateSummary(taskId: string, summary: string): boolean {
    const task = this.findTask(this.store.tasks, taskId)
    if (!task) return false
    task.summary = summary
    task.updatedAt = new Date().toISOString()
    this.saveStore()
    return true
  }

  /** 添加笔记 */
  addNote(taskId: string, note: string): boolean {
    const task = this.findTask(this.store.tasks, taskId)
    if (!task) return false
    task.notes.push(`[${new Date().toISOString()}] ${note}`)
    task.updatedAt = new Date().toISOString()
    this.saveStore()
    return true
  }

  /** 获取任务 */
  getTask(taskId: string): Task | null {
    return this.findTask(this.store.tasks, taskId)
  }

  /** 获取所有任务 */
  getAllTasks(): Task[] {
    return this.store.tasks
  }

  /** 获取活跃任务 */
  getActiveTasks(): Task[] {
    return this.filterTasks(this.store.tasks, (t) =>
      t.status === "open" || t.status === "in_progress"
    )
  }

  /** 生成任务树的文本表示 */
  toText(tasks?: Task[], indent = 0): string {
    const list = tasks || this.store.tasks
    const lines: string[] = []
    for (const task of list) {
      const statusIcon = {
        open: "○",
        in_progress: "●",
        blocked: "◐",
        done: "✓",
        abandoned: "✗",
      }[task.status]
      const prefix = "  ".repeat(indent)
      lines.push(`${prefix}${statusIcon} ${task.id}: ${task.summary} [${task.status}]`)
      if (task.children.length > 0) {
        lines.push(this.toText(task.children, indent + 1))
      }
    }
    return lines.join("\n")
  }

  /** 生成系统提示 */
  toSystemPrompt(): string {
    const active = this.getActiveTasks()
    if (active.length === 0) return ""
    return (
      `[Active tasks]\n` +
      active.map((t) => `- ${t.id}: ${t.summary} (${t.status})`).join("\n")
    )
  }

  /** 持久化到磁盘 */
  persist(): void {
    this.saveStore()
  }

  private findTask(tasks: Task[], id: string): Task | null {
    for (const task of tasks) {
      if (task.id === id) return task
      if (task.children.length > 0) {
        const found = this.findTask(task.children, id)
        if (found) return found
      }
    }
    return null
  }

  private filterTasks(tasks: Task[], predicate: (t: Task) => boolean): Task[] {
    const result: Task[] = []
    for (const task of tasks) {
      if (predicate(task)) result.push(task)
      if (task.children.length > 0) {
        result.push(...this.filterTasks(task.children, predicate))
      }
    }
    return result
  }

  private loadStore(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8")
        this.store = JSON.parse(raw)
      }
    } catch {
      this.store = { tasks: [] }
    }
  }

  private saveStore(): void {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), "utf-8")
    } catch { /* 静默 */ }
  }
}

/** 全局 TaskTracker 实例 */
export const taskTracker = new TaskTracker()

