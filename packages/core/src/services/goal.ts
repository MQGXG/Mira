/**
 * Goal 服务 — ctx.goal
 * 持有 GoalJudge 实例（sidecar/api.ts 与 Agent 构造共享，消除双实例）。
 */

import { Service } from "../vendor/cordis/index"
import { GoalJudge } from "../orchestrate/goal-judge"
import type { Goal, GoalConfig, GoalEvaluation } from "../orchestrate/goal-judge"
import type { LLMMessage } from "../llm/schema/messages"
import type { GoalService } from "../framework/context"

export class MiraGoalService extends Service implements GoalService {
  static provide = "goal"

  private judge: GoalJudge

  constructor(ctx: import("../vendor/cordis/index").Context, config?: { judge?: GoalJudge }) {
    super(ctx, "goal")
    this.judge = config?.judge ?? new GoalJudge()
  }

  setJudgeConfig(config: GoalConfig): void {
    this.judge.setJudgeConfig(config)
  }

  bindSession(sessionID: string): void {
    this.judge.bindSession(sessionID)
  }

  setGoal(description: string, timeoutMs?: number): Goal {
    return this.judge.setGoal(description, timeoutMs)
  }

  getActiveGoal(): Goal | null {
    return this.judge.getActiveGoal()
  }

  getAllGoals(): Goal[] {
    return this.judge.getAllGoals()
  }

  cancelGoal(): boolean {
    return this.judge.cancelGoal()
  }

  isTimedOut(goal: Goal): boolean {
    return this.judge.isTimedOut(goal)
  }

  evaluate(goal: Goal, messages: LLMMessage[], config?: GoalConfig): Promise<GoalEvaluation> {
    return this.judge.evaluate(goal, messages, config)
  }

  quickCheck(goal: Goal, messages: LLMMessage[]): GoalEvaluation | null {
    return this.judge.quickCheck(goal, messages)
  }

  toSystemPrompt(): string {
    return this.judge.toSystemPrompt()
  }

  toText(): string {
    return this.judge.toText()
  }

  load(sessionID: string): Promise<void> {
    return this.judge.load(sessionID)
  }

  save(): Promise<void> {
    return this.judge.save()
  }

  getJudge(): GoalJudge {
    return this.judge
  }
}