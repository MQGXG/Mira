import { Agent, type AgentConfig, type AgentEvent } from "./agent/agent"
import type { LLMMessage } from "./llm/client"
import type { CheckpointProvider } from "./memory/checkpoint-provider"
import type { SubagentManager } from "./orchestrate/subagent"

export type ComposePhase =
  | "plan"
  | "execute"
  | "review"
  | "test"
  | "debug"
  | "verify"
  | "merge"

export interface ComposeSpec {
  title: string
  description: string
  requirements: string[]
  acceptanceCriteria: string[]
}

export interface ComposeState {
  phase: ComposePhase
  spec: ComposeSpec
  plan: string | null
  codeFiles: string[]
  reviewComments: string[]
  testResults: string[]
  debugLog: string[]
  verificationPassed: boolean
  startedAt: string
  updatedAt: string
}

export interface ComposeSkill {
  name: string
  description: string
  phase: ComposePhase
  systemPrompt: string
  tools: string[]
}

const COMPOSE_SKILLS: Record<ComposePhase, ComposeSkill> = {
  plan: {
    name: "plan",
    description: "理解需求，设计方案",
    phase: "plan",
    systemPrompt: `You are a planning agent. Your task is to:
1. Understand the specification/requirement
2. Analyze the current codebase
3. Design a detailed implementation plan
4. Identify files to modify/create
5. Define success criteria

Output a structured plan with:
- Overview of the solution
- Step-by-step implementation steps
- Files to modify/create
- Risk assessment
- Success criteria`,
    tools: ["read_file", "list_files", "grep", "glob", "web_search", "web_browse", "data_analysis"],
  },
  execute: {
    name: "execute",
    description: "编写代码实现",
    phase: "execute",
    systemPrompt: `You are an execution agent. Your task is to implement the plan:
1. Read the plan carefully
2. Implement each step
3. Follow existing code conventions
4. Write clean, maintainable code
5. Track all files modified

Output:
- Files created/modified
- Implementation summary
- Any deviations from the plan`,
    tools: ["read_file", "write_file", "edit_file", "list_files", "grep", "glob", "bash"],
  },
  review: {
    name: "review",
    description: "代码审查",
    phase: "review",
    systemPrompt: `You are a code review agent. Your task is to review the implementation:
1. Check code quality
2. Verify correctness
3. Check for edge cases
4. Review security implications
5. Suggest improvements

Output:
- Review comments (issues found)
- Suggestions for improvement
- Approval status (approve/request changes)`,
    tools: ["read_file", "list_files", "grep", "glob"],
  },
  test: {
    name: "test",
    description: "TDD 测试",
    phase: "test",
    systemPrompt: `You are a testing agent. Your task is to:
1. Write comprehensive tests
2. Cover edge cases
3. Run tests and verify results
4. Report test coverage

Output:
- Test files created
- Test results
- Coverage report
- Issues found`,
    tools: ["read_file", "write_file", "edit_file", "bash", "code_exec"],
  },
  debug: {
    name: "debug",
    description: "调试修复",
    phase: "debug",
    systemPrompt: `You are a debugging agent. Your task is to:
1. Analyze the issue
2. Find root cause
3. Implement fix
4. Verify the fix

Output:
- Root cause analysis
- Fix implemented
- Verification results`,
    tools: ["read_file", "edit_file", "bash", "code_exec", "grep"],
  },
  verify: {
    name: "verify",
    description: "验证实现",
    phase: "verify",
    systemPrompt: `You are a verification agent. Your task is to:
1. Verify all requirements are met
2. Run integration tests
3. Check for regressions
4. Confirm success criteria

Output:
- Verification checklist
- Test results
- Pass/fail status`,
    tools: ["read_file", "list_files", "bash", "code_exec"],
  },
  merge: {
    name: "merge",
    description: "合并变更",
    phase: "merge",
    systemPrompt: `You are a merge agent. Your task is to:
1. Review all changes
2. Create git commit
3. Handle conflicts if any
4. Prepare for deployment

Output:
- Git commit message
- Files committed
- Any conflicts resolved`,
    tools: ["read_file", "git_status", "git_diff", "git_log", "git_commit"],
  },
}

const PHASE_ORDER: ComposePhase[] = ["plan", "execute", "review", "test", "debug", "verify", "merge"]

export class ComposeModeManager {
  private state: ComposeState | null = null
  private history: ComposeState[] = []
  private checkpointProvider: CheckpointProvider | null = null
  private subagentManager: SubagentManager | null = null
  private agentConfig: AgentConfig | null = null
  private subagentIds: string[] = []
  /** phase skill 表（默认内置，registerPhase/构造注入可扩展替换） */
  private skills: Record<ComposePhase, ComposeSkill>
  /** phase 顺序（默认内置，构造可注入自定义流程） */
  private phaseOrder: ComposePhase[]

  constructor(options?: { skills?: Partial<Record<ComposePhase, ComposeSkill>>; phaseOrder?: ComposePhase[] }) {
    this.skills = { ...COMPOSE_SKILLS, ...(options?.skills || {}) }
    this.phaseOrder = options?.phaseOrder || PHASE_ORDER
  }

  /**
   * 注册/替换 phase skill（Cordis 插件式：返回 disposer 可逆）。
   * 自定义 phase 可通过构造器 phaseOrder 注入参与流程。
   */
  registerPhase(phase: ComposePhase, skill: ComposeSkill): () => void {
    const prev = this.skills[phase]
    this.skills[phase] = skill
    return () => {
      if (prev) this.skills[phase] = prev
      else delete this.skills[phase]
    }
  }

  setCheckpointProvider(provider: CheckpointProvider): void {
    this.checkpointProvider = provider
  }

  setSubagentManager(manager: SubagentManager): void {
    this.subagentManager = manager
  }

  /** 已接线的 SubagentManager（可空）：服务装配经 ctx.subagent 注入 */
  getSubagentManager(): SubagentManager | null {
    return this.subagentManager
  }

  setAgentConfig(config: AgentConfig): void {
    this.agentConfig = config
  }

  async *run(
    spec: string,
    config: AgentConfig,
  ): AsyncGenerator<AgentEvent> {
    const parsedSpec = this.parseSpec(spec)
    this.startFromParsed(parsedSpec)
    yield { type: "thinking", text: `📋 Starting compose: ${parsedSpec.title} — phase: plan` }

    for (const phase of this.phaseOrder) {
      if (this.state) this.state.phase = phase

      const skill = this.skills[phase]
      const phasePrompt = this.buildPhasePrompt(skill)
      yield { type: "thinking", text: `🔄 Entering phase: ${phase} — ${skill.description}` }

      let phaseCompleted = false
      while (!phaseCompleted) {
        const result = await this.executePhase(phase, phasePrompt, config)

        if (result.status === "completed") {
          phaseCompleted = true
          yield { type: "thinking", text: `✅ Phase ${phase} completed` }
          this.onPhaseComplete(phase, result.output || "")
        } else if (result.status === "failed") {
          yield { type: "error", message: `Phase ${phase} failed: ${result.error}` }
          return
        } else {
          phaseCompleted = true
        }
      }
    }

    yield { type: "thinking", text: "🎉 All compose phases completed!" }
    yield { type: "finish", reason: "compose_complete" }
  }

  private async executePhase(
    phase: ComposePhase,
    prompt: string,
    config: AgentConfig,
  ): Promise<{ status: "completed" | "failed"; output?: string; error?: string }> {
    const skill = this.skills[phase]

    const phaseConfig: AgentConfig = {
      ...config,
      systemPrompt: skill.systemPrompt,
      toolAllowlist: skill.tools,
      maxSteps: phase === "plan" ? 15 : phase === "execute" ? 50 : 25,
    }

    if (this.subagentManager && config.apiKey) {
      try {
        const subagentInfo = this.subagentManager.spawn(
          `compose-${phase}`,
          phaseConfig,
          { prompt },
        )
        this.subagentIds.push(subagentInfo.id)

        const completedInfo = await this.subagentManager.wait(subagentInfo.id, 600000)
        if (completedInfo.status === "completed") {
          return { status: "completed", output: completedInfo.result || undefined }
        }
        return { status: "failed", error: completedInfo.error || `Subagent ${completedInfo.status}` }
      } catch (err) {
        return { status: "failed", error: String(err) }
      }
    }

    return { status: "completed" }
  }

  private onPhaseComplete(phase: ComposePhase, output: string): void {
    if (!this.state) return

    if (this.checkpointProvider) {
      const checkpoint = this.checkpointProvider.getCheckpoint()
      const summary = checkpoint?.summary || ""
      const phaseNote = `[Compose] Phase ${phase} completed: ${output.slice(0, 200)}`
      this.checkpointProvider.updateSummary(summary ? `${summary}\n${phaseNote}` : phaseNote)
    }

    const completedState = { ...this.state, phase, updatedAt: new Date().toISOString() }
    this.history.push(completedState)
  }

  start(spec: string): ComposeState {
    if (this.state) this.history.push({ ...this.state })
    const parsed = this.parseSpec(spec)
    return this.startFromParsed(parsed)
  }

  private parseSpec(spec: string): ComposeSpec {
    const lines = spec.split("\n").filter(Boolean)
    const title = lines[0]?.replace(/^[#\s]*/, "") || "Untitled"
    const requirements: string[] = []
    const acceptanceCriteria: string[] = []
    let inCriteria = false

    for (const line of lines.slice(1)) {
      const trimmed = line.trim()
      if (/^(验收|acceptance|criteria)/i.test(trimmed)) {
        inCriteria = true
        continue
      }
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        const item = trimmed.slice(2).trim()
        if (inCriteria) {
          acceptanceCriteria.push(item)
        } else {
          requirements.push(item)
        }
      }
    }

    return { title, description: spec.slice(0, 500), requirements, acceptanceCriteria }
  }

  private startFromParsed(spec: ComposeSpec): ComposeState {
    this.state = {
      phase: "plan",
      spec,
      plan: null,
      codeFiles: [],
      reviewComments: [],
      testResults: [],
      debugLog: [],
      verificationPassed: false,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    return { ...this.state }
  }

  private buildPhasePrompt(skill: ComposeSkill): string {
    if (!this.state) return skill.description
    const lines: string[] = [
      `# Compose Phase: ${skill.name}`,
      "",
      skill.description,
      "",
      `## Spec`,
      this.state.spec.description,
    ]

    if (this.state.spec.requirements.length > 0) {
      lines.push("", "## Requirements", ...this.state.spec.requirements.map(r => `- ${r}`))
    }
    if (this.state.spec.acceptanceCriteria.length > 0) {
      lines.push("", "## Acceptance Criteria", ...this.state.spec.acceptanceCriteria.map(c => `- ${c}`))
    }
    if (this.state.plan && skill.phase !== "plan") {
      lines.push("", "## Plan", this.state.plan)
    }

    return lines.join("\n")
  }

  getState(): ComposeState | null {
    return this.state ? { ...this.state } : null
  }

  getCurrentSkill(): ComposeSkill | null {
    if (!this.state) return null
    return this.skills[this.state.phase]
  }

  advance(): ComposePhase | null {
    if (!this.state) return null
    const currentIdx = this.phaseOrder.indexOf(this.state.phase)
    if (currentIdx === this.phaseOrder.length - 1) return null
    this.state.phase = this.phaseOrder[currentIdx + 1]
    this.state.updatedAt = new Date().toISOString()
    return this.state.phase
  }

  goTo(phase: ComposePhase): boolean {
    if (!this.state || !this.phaseOrder.includes(phase)) return false
    this.state.phase = phase
    this.state.updatedAt = new Date().toISOString()
    return true
  }

  update(updates: Partial<ComposeState>): void {
    if (!this.state) return
    Object.assign(this.state, updates, { updatedAt: new Date().toISOString() })
  }

  addCodeFile(filePath: string): void {
    if (!this.state) return
    if (!this.state.codeFiles.includes(filePath)) {
      this.state.codeFiles.push(filePath)
      this.state.updatedAt = new Date().toISOString()
    }
  }

  addReviewComment(comment: string): void {
    if (!this.state) return
    this.state.reviewComments.push(comment)
    this.state.updatedAt = new Date().toISOString()
  }

  addTestResult(result: string): void {
    if (!this.state) return
    this.state.testResults.push(result)
    this.state.updatedAt = new Date().toISOString()
  }

  addDebugLog(log: string): void {
    if (!this.state) return
    this.state.debugLog.push(log)
    this.state.updatedAt = new Date().toISOString()
  }

  setVerificationPassed(passed: boolean): void {
    if (!this.state) return
    this.state.verificationPassed = passed
    this.state.updatedAt = new Date().toISOString()
  }

  complete(): ComposeState | null {
    if (!this.state) return null
    const completed = { ...this.state }
    this.history.push(completed)
    this.state = null
    return completed
  }

  cancel(): ComposeState | null {
    if (!this.state) return null
    for (const id of this.subagentIds) {
      this.subagentManager?.cancel(id)
    }
    this.subagentIds = []
    const cancelled = { ...this.state, phase: "plan" as ComposePhase }
    this.history.push(cancelled)
    this.state = null
    return cancelled
  }

  getHistory(): ComposeState[] {
    return [...this.history]
  }

  toText(): string {
    if (!this.state) return "No active compose session"
    const lines: string[] = [
      "# Compose Session",
      "",
      `Phase: ${this.state.phase}`,
      `Spec: ${this.state.spec.title}`,
      `Started: ${this.state.startedAt}`,
      `Updated: ${this.state.updatedAt}`,
    ]
    if (this.state.plan) lines.push("", "## Plan", this.state.plan)
    if (this.state.codeFiles.length > 0) {
      lines.push("", "## Code Files", ...this.state.codeFiles.map(f => `- ${f}`))
    }
    if (this.state.reviewComments.length > 0) {
      lines.push("", "## Review Comments", ...this.state.reviewComments.map(c => `- ${c}`))
    }
    if (this.state.testResults.length > 0) {
      lines.push("", "## Test Results", ...this.state.testResults.map(r => `- ${r}`))
    }
    if (this.state.debugLog.length > 0) {
      lines.push("", "## Debug Log", ...this.state.debugLog.map(l => `- ${l}`))
    }
    lines.push("", `Verification: ${this.state.verificationPassed ? "PASSED" : "NOT PASSED"}`)
    return lines.join("\n")
  }

  toSystemPrompt(): string {
    if (!this.state) return ""
    const skill = this.getCurrentSkill()
    if (!skill) return ""
    return (
      `[Compose Mode: ${this.state.phase}]\n` +
      `Spec: ${this.state.spec.title}\n` +
      (this.state.plan ? `Plan: ${this.state.plan.slice(0, 200)}...\n` : "") +
      `Task: ${skill.description}\n` +
      `Available tools: ${skill.tools.join(", ")}`
    )
  }

  static getSkills(): ComposeSkill[] {
    return PHASE_ORDER.map(p => COMPOSE_SKILLS[p])
  }

  static getPhaseOrder(): ComposePhase[] {
    return [...PHASE_ORDER]
  }

  /** 实例级 phase skill 表（含 registerPhase 扩展，服务寻址用） */
  getSkillsMap(): Record<ComposePhase, ComposeSkill> {
    return { ...this.skills }
  }
}




