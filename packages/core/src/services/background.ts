/**
 * 后台任务服务 — ctx.background
 * 队列（startBackground）+ 定时调度（cronScheduler）+ 完成通知（BackgroundNotifier）统一寻址。
 * 生命周期：服务装配时启动调度器，卸载时停止（Cordis Fiber 回滚）。
 */

import { Service } from "../vendor/cordis/index"
import {
  startBackground,
  getTaskStatus,
  listBackgroundTasks,
  cleanupBackgroundTasks,
  isSlowOperation,
  setBackgroundNotifier,
} from "../background/index"
import { cronScheduler } from "../background/cron"
import type { BackgroundTask } from "../background/index"
import type { BackgroundService } from "../framework/context"

export class MiraBackgroundService extends Service implements BackgroundService {
  static provide = "background"

  constructor(ctx: import("../vendor/cordis/index").Context) {
    super(ctx, "background")
    // 调度器随服务生命周期启停（幂等：CronScheduler.start 有 running guard）
    cronScheduler.start()
    ctx.effect(() => () => {
      cronScheduler.stop()
    })
  }

  start(name: string, handler: () => Promise<string>): string {
    return startBackground(name, handler)
  }

  getTaskStatus(id: string): BackgroundTask | undefined {
    return getTaskStatus(id)
  }

  list(): BackgroundTask[] {
    return listBackgroundTasks()
  }

  cleanup(olderThanMs = 300000): void {
    cleanupBackgroundTasks(olderThanMs)
  }

  isSlowOperation(command: string): boolean {
    return isSlowOperation(command)
  }

  schedule(cron: string, task: () => Promise<void>): string {
    const id = `cron-${Date.now().toString(36)}`
    cronScheduler.add(id, cron, id, task)
    return id
  }

  unschedule(id: string): boolean {
    cronScheduler.remove(id)
    return true
  }

  /** 列出全部定时任务（cron-tool 经服务寻址，不再直取模块级单例） */
  listCron(): import("../background/cron").CronTask[] {
    return cronScheduler.list()
  }

  /** 精确注册定时任务（指定 id，cron-tool add 语义） */
  addCron(id: string, expression: string, description: string, handler: () => Promise<void>): void {
    cronScheduler.add(id, expression, description, handler)
  }

  /** 移除定时任务（幂等：不存在时无操作） */
  removeCron(id: string): void {
    cronScheduler.remove(id)
  }

  setNotifier(notifier: unknown): void {
    setBackgroundNotifier(notifier as never)
  }
}