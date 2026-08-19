/**
 * TaskGate — 任务完成门控
 * 子 Agent 完成后验证是否真的完成了所有分配的任务
 */

import { parseActorResult, injectReturnFormat } from "./actor-protocol";

export interface TaskRecord {
  id: string;
  actorId: string;
  description: string;
  status: "pending" | "completed" | "failed" | "skipped";
  createdAt: string;
  completedAt?: string;
}

export interface GateDecision {
  status: "success" | "partial" | "failed" | "blocked";
  feedback?: string;
  retryCount: number;
}

const MAX_RETRIES = 2;

export class TaskGate {
  private tasks: Map<string, TaskRecord[]> = new Map();
  private retryCounts: Map<string, number> = new Map();

  /** 注册任务到 Actor */
  registerTask(actorId: string, description: string): string {
    const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const records = this.tasks.get(actorId) || [];
    records.push({ id, actorId, description, status: "pending", createdAt: new Date().toISOString() });
    this.tasks.set(actorId, records);
    return id;
  }

  /** 标记任务完成 */
  completeTask(taskId: string): void {
    for (const [, records] of this.tasks) {
      const task = records.find((r) => r.id === taskId);
      if (task) {
        task.status = "completed";
        task.completedAt = new Date().toISOString();
        return;
      }
    }
  }

  /** 获取 Actor 的待完成任务 */
  getPendingTasks(actorId: string): TaskRecord[] {
    return (this.tasks.get(actorId) || []).filter((r) => r.status === "pending");
  }

  /** 获取指定 Actor 的所有任务 */
  getTasks(actorId: string): TaskRecord[] {
    return this.tasks.get(actorId) || [];
  }

  /** 检查子 Agent 输出决定是否通过门控 */
  decide(actorId: string, result: string): GateDecision {
    const parsed = parseActorResult(result);
    const retryCount = this.retryCounts.get(actorId) || 0;

    // 如果解析出了 Standard 协议头
    if (parsed) {
      if (parsed.status === "success") {
        const pending = this.getPendingTasks(actorId);
        if (pending.length === 0) {
          return { status: "success", retryCount };
        }
        // 子 Agent 说完成了但还有未完成任务
        if (retryCount < MAX_RETRIES) {
          this.retryCounts.set(actorId, retryCount + 1);
          const descriptions = pending.map((t) => `- ${t.description}`).join("\n");
          return {
            status: "partial",
            feedback: `还有以下任务未完成：\n${descriptions}\n\n请继续完成。`,
            retryCount: retryCount + 1,
          };
        }
        return { status: "partial", feedback: "多次提醒后仍有未完成任务，自动降级。", retryCount };
      }

      // 子 Agent 报告了失败
      if (retryCount < MAX_RETRIES) {
        this.retryCounts.set(actorId, retryCount + 1);
        return {
          status: "partial",
          feedback: `报告状态: ${parsed.status}\n反馈: ${parsed.summary}\n\n请重新尝试或调整方案。`,
          retryCount: retryCount + 1,
        };
      }
      return { status: "blocked", feedback: "多次尝试后仍失败，自动终止。", retryCount };
    }

    // 没有标准化协议头 — 降级处理
    if (retryCount < MAX_RETRIES) {
      this.retryCounts.set(actorId, retryCount + 1);
      return {
        status: "partial",
        feedback: "回复中缺少标准化结果格式。请在你的回复末尾包含：\n\n**Status**: success | partial | failed | blocked\n**Summary**: <一句话概括>",
        retryCount: retryCount + 1,
      };
    }
    return { status: "blocked", feedback: "多次缺少标准化格式，自动终止。", retryCount };
  }

  /** 清理 Actor 相关数据 */
  cleanup(actorId: string): void {
    this.tasks.delete(actorId);
    this.retryCounts.delete(actorId);
  }
}
