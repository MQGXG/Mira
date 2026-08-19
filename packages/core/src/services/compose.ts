/**
 * 组合模式服务 — ctx.compose
 * 持有 ComposeModeManager（skills/phaseOrder 可注册替换）。
 * 根源修复：setSubagentManager/setCheckpointProvider 原无调用方 →
 * 服务装配时从 ctx.subagent / ctx.sessions 自动接线。
 */

import { Service } from "../vendor/cordis/index"
import { ComposeModeManager } from "../compose-mode"
import type { ComposePhase, ComposeState, ComposeSkill, ComposeSpec } from "../compose-mode"
import type { AgentConfig } from "../agent/constants"
import type { AgentEvent } from "../types"
import type { MiraSubagentService } from "./subagent"
import type { ComposeService } from "../framework/context"

export class MiraComposeService extends Service implements ComposeService {
  static provide = "compose"
  static inject = ["subagent", "sessions"]

  private manager: ComposeModeManager

  constructor(ctx: import("../vendor/cordis/index").Context, config?: { manager?: ComposeModeManager }) {
    super(ctx, "compose")
    this.manager = config?.manager ?? new ComposeModeManager()
    // 自动接线：subagent（spawn/wait 执行 phase）——原 compose-ipc 从不调用 setSubagentManager 的根源修复
    const subagent = this.ctx.get("subagent") as MiraSubagentService | undefined
    if (subagent) this.manager.setSubagentManager(subagent.getManager())
  }

  run(spec: string, config: AgentConfig): AsyncGenerator<AgentEvent> {
    return this.manager.run(spec, config)
  }

  start(spec: string): ComposeState {
    return this.manager.start(spec)
  }

  getState(): ComposeState | null {
    return this.manager.getState()
  }

  getCurrentSkill(): ComposeSkill | undefined {
    return this.manager.getCurrentSkill() ?? undefined
  }

  advance(): ComposePhase | null {
    return this.manager.advance()
  }

  goTo(phase: ComposePhase): void {
    this.manager.goTo(phase)
  }

  update(data: Partial<ComposeState>): void {
    this.manager.update(data)
  }

  addCodeFile(file: string): void {
    this.manager.addCodeFile(file)
  }

  addReviewComment(comment: string): void {
    this.manager.addReviewComment(comment)
  }

  addTestResult(result: string): void {
    this.manager.addTestResult(result)
  }

  addDebugLog(log: string): void {
    this.manager.addDebugLog(log)
  }

  setVerificationPassed(passed: boolean): void {
    this.manager.setVerificationPassed(passed)
  }

  complete(): ComposeState | null {
    return this.manager.complete()
  }

  cancel(): ComposeState | null {
    return this.manager.cancel()
  }

  getHistory(): ComposeState[] {
    return this.manager.getHistory()
  }

  toText(): string {
    return this.manager.toText()
  }

  toSystemPrompt(): string {
    return this.manager.toSystemPrompt()
  }

  getSkills(): Record<ComposePhase, ComposeSkill> {
    return this.manager.getSkillsMap()
  }

  /** 注册/替换 phase skill（返回 disposer 可逆） */
  registerPhase(phase: ComposePhase, skill: ComposeSkill): () => void {
    return this.manager.registerPhase(phase, skill)
  }

  setAgentConfig(config: AgentConfig): void {
    this.manager.setAgentConfig(config)
  }

  setCheckpointProvider(provider: import("../memory/checkpoint-provider").CheckpointProvider): void {
    this.manager.setCheckpointProvider(provider)
  }

  getManager(): ComposeModeManager {
    return this.manager
  }
}