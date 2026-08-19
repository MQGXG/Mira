/**
 * 任务/计划系统 — DAG 图任务执行器
 * 允许 Agent 将复杂工作分解为多步计划，按依赖顺序执行
 */

import { randomUUID } from "crypto"

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped"

export interface TaskDef {
  id: string
  description: string
  dependsOn: string[]
  execute: () => Promise<string>
}

export interface TaskState {
  id: string
  description: string
  status: TaskStatus
  dependsOn: string[]
  result: string
  error: string
  startedAt: number
  completedAt: number
}

export class TaskPlanner {
  private tasks = new Map<string, TaskState>()
  private definitions = new Map<string, TaskDef>()

  /** 定义一个新任务（不执行） */
  define(task: TaskDef): void {
    this.definitions.set(task.id, task)
    this.tasks.set(task.id, {
      id: task.id,
      description: task.description,
      status: "pending",
      dependsOn: task.dependsOn,
      result: "",
      error: "",
      startedAt: 0,
      completedAt: 0,
    })
  }

  /** 获取所有任务状态 */
  getAllStates(): TaskState[] {
    return Array.from(this.tasks.values())
  }

  /** 获取指定任务状态 */
  getState(id: string): TaskState | undefined {
    return this.tasks.get(id)
  }

  /** 检查是否有环 */
  detectCycle(): string[] {
    const visited = new Set<string>()
    const recursionStack = new Set<string>()
    const cycle: string[] = []

    function dfs(tasks: Map<string, TaskDef>, id: string, path: string[]): boolean {
      if (recursionStack.has(id)) {
        const idx = path.indexOf(id)
        cycle.push(...path.slice(idx), id)
        return true
      }
      if (visited.has(id)) return false
      visited.add(id)
      recursionStack.add(id)
      path.push(id)

      const def = tasks.get(id)
      if (def) {
        for (const dep of def.dependsOn) {
          if (dfs(tasks, dep, path)) return true
        }
      }

      recursionStack.delete(id)
      path.pop()
      return false
    }

    for (const id of this.definitions.keys()) {
      if (!visited.has(id)) {
        dfs(this.definitions, id, [])
        if (cycle.length > 0) return cycle
      }
    }

    return []
  }

  /** 获取当前可执行的任务（所有依赖已完成） */
  getRunnableTasks(): TaskState[] {
    return Array.from(this.tasks.values()).filter((t) => {
      if (t.status !== "pending") return false
      return t.dependsOn.every((depId) => {
        const dep = this.tasks.get(depId)
        return dep?.status === "done" || dep?.status === "skipped"
      })
    })
  }

  /** 检查是否所有任务都已完成 */
  isComplete(): boolean {
    return Array.from(this.tasks.values()).every((t) =>
      t.status === "done" || t.status === "failed" || t.status === "skipped"
    )
  }

  /** 获取失败的任务 */
  getFailedTasks(): TaskState[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === "failed")
  }

  /** 执行所有可运行的任务（并行执行无依赖冲突的任务） */
  async executeRunnable(): Promise<TaskState[]> {
    const runnable = this.getRunnableTasks()
    if (runnable.length === 0) return []

    const results = await Promise.all(
      runnable.map(async (task) => {
        const def = this.definitions.get(task.id)
        if (!def) {
          task.status = "skipped"
          task.error = "Definition not found"
          return task
        }

        task.status = "running"
        task.startedAt = Date.now()
        try {
          task.result = await def.execute()
          task.status = "done"
        } catch (e) {
          task.error = e instanceof Error ? e.message : String(e)
          task.status = "failed"
        }
        task.completedAt = Date.now()
        return task
      })
    )

    return results
  }

  /** 执行完整计划（轮询直到所有任务完成） */
  async executeAll(maxIterations = 100): Promise<TaskState[]> {
    const allResults: TaskState[] = []
    for (let i = 0; i < maxIterations; i++) {
      const results = await this.executeRunnable()
      allResults.push(...results)
      if (this.isComplete()) break
      // 如果本次没有运行任何任务但未完成，说明有阻塞
      if (results.length === 0) {
        const pending = Array.from(this.tasks.values()).filter((t) => t.status === "pending")
        if (pending.length > 0) {
          for (const p of pending) {
            p.status = "skipped"
            p.error = `Blocked by dependencies: ${p.dependsOn.filter((d) => this.tasks.get(d)?.status !== "done" && this.tasks.get(d)?.status !== "skipped").join(", ")}`
          }
        }
        break
      }
    }
    return allResults
  }

  /** 清除所有任务 */
  clear(): void {
    this.tasks.clear()
    this.definitions.clear()
  }

  /** 生成计划摘要 */
  summary(): string {
    const states = this.getAllStates()
    const done = states.filter((s) => s.status === "done").length
    const failed = states.filter((s) => s.status === "failed").length
    const skipped = states.filter((s) => s.status === "skipped").length
    const pending = states.filter((s) => s.status === "pending").length
    const running = states.filter((s) => s.status === "running").length

    return [
      `计划进度: ${done + failed + skipped}/${states.length} 完成`,
      `- 已完成: ${done}`,
      `- 执行中: ${running}`,
      `- 待处理: ${pending}`,
      `- 失败: ${failed}`,
      `- 跳过: ${skipped}`,
      ...(failed > 0 ? ["", "失败任务:"] : []),
      ...this.getFailedTasks().map((t) => `  - ${t.description}: ${t.error}`),
    ].join("\n")
  }
}
