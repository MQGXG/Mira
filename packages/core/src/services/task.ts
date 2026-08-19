/**
 * 任务服务 — ctx.task
 * TaskTracker（会话任务 CRUD）+ TaskPlanner（DAG 计划注册表，从 task-tool 模块级 Map 迁入）单一寻址。
 */

import { Service } from "../vendor/cordis/index"
import { TaskTracker, taskTracker } from "../task/tracker"
import { TaskPlanner } from "../task/planner"
import type { Task, TaskStatus } from "../task/tracker"
import type { TaskDef, TaskState } from "../task/planner"
import type { TaskService } from "../framework/context"

export class MiraTaskService extends Service implements TaskService {
  static provide = "task"

  private tracker: TaskTracker
  private planners = new Map<string, TaskPlanner>()

  constructor(ctx: import("../vendor/cordis/index").Context, config?: { tracker?: TaskTracker }) {
    super(ctx, "task")
    this.tracker = config?.tracker ?? taskTracker
  }

  initialize(sessionId: string): void {
    this.tracker.initialize(sessionId)
  }

  create(summary: string, parentId?: string): Task {
    return this.tracker.create(summary, parentId)
  }

  updateStatus(id: string, status: TaskStatus): boolean {
    return this.tracker.updateStatus(id, status)
  }

  updateSummary(id: string, summary: string): boolean {
    return this.tracker.updateSummary(id, summary)
  }

  addNote(id: string, note: string): boolean {
    return this.tracker.addNote(id, note)
  }

  getTask(id: string): Task | null {
    return this.tracker.getTask(id)
  }

  getAllTasks(): Task[] {
    return this.tracker.getAllTasks()
  }

  getActiveTasks(): Task[] {
    return this.tracker.getActiveTasks()
  }

  toText(): string {
    return this.tracker.toText()
  }

  persist(): void {
    this.tracker.persist()
  }

  createPlan(id: string): TaskPlanner {
    let planner = this.planners.get(id)
    if (!planner) {
      planner = new TaskPlanner()
      this.planners.set(id, planner)
    }
    return planner
  }

  definePlan(def: TaskDef): TaskPlanner {
    const planner = this.createPlan(def.id || `plan-${def.description.slice(0, 16)}`)
    return planner
  }

  executePlan(id: string): Promise<TaskState[]> {
    const planner = this.planners.get(id)
    if (!planner) throw new Error(`计划 "${id}" 不存在`)
    return planner.executeAll()
  }

  getPlan(id: string): TaskPlanner | undefined {
    return this.planners.get(id)
  }

  deletePlan(id: string): boolean {
    return this.planners.delete(id)
  }

  clearPlans(): void {
    this.planners.clear()
  }

  getTracker(): TaskTracker {
    return this.tracker
  }
}