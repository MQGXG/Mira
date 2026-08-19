import { createLLMClient, type LLMMessage } from "../llm/client"
import { logError } from "../system/logger"
import { getDbAsync, runWrite } from "../system/database"

export interface GoalConfig {
  apiKey: string
  apiUrl: string
  model: string
  provider: string
}

export interface Goal {
  id: string
  description: string
  createdAt: string
  status: "active" | "satisfied" | "failed" | "cancelled" | "timed_out"
  satisfiedAt: string | null
  evaluations: GoalEvaluation[]
  /** 超时时间（毫秒），从 createdAt 开始计算，0 表示无超时 */
  timeoutMs: number
}

export interface GoalEvaluation {
  timestamp: string
  satisfied: boolean
  reasoning: string
  confidence: number
  /** 完成证据（文件 diff / 测试输出 / schema 校验结果），Evidence-based 判定 */
  evidence?: string[]
}

const JUDGE_SYSTEM_PROMPT = `You are an impartial goal evaluation judge. Your role is to determine whether a given goal has been achieved based on the conversation history.

Rules:
1. Be strict — only mark satisfied if there is clear evidence the goal is fully achieved
2. Consider partial progress as NOT satisfied
3. If the agent is still working toward the goal, mark as not satisfied
4. Look for concrete results, not just intent
5. Do NOT rely on confidence — rely on evidence. If the agent merely claims completion without test output, diff, or verification results, mark as not satisfied

Respond in JSON format:
{
  "satisfied": boolean,
  "reasoning": "Concise explanation of your decision",
  "confidence": 0.0-1.0,
  "evidence": ["Concrete evidence items backing the decision"]
}`

export class GoalJudge {
  private goals: Goal[] = []
  private goalCounter = 0
  private judgeConfig: GoalConfig | null = null
  private sessionID = ""
  private consecutiveFails = 0
  private readonly MAX_CONSECUTIVE_FAILS = 3
  private readonly MAX_TOTAL_EVALS = 12

  setJudgeConfig(config: GoalConfig): void {
    this.judgeConfig = config
  }

  /** 绑定 session ID（用于持久化） */
  bindSession(sessionID: string): void {
    this.sessionID = sessionID
  }

  // ── 持久化 ──────────────────────────────────────────

  /** 从 SQLite 加载当前会话的 goal */
  async load(sessionID: string): Promise<void> {
    try {
      const db = await getDbAsync()
      const rows = db.exec(
        "SELECT id, description, created_at, status, satisfied_at, timeout_ms, evaluations_json FROM goals WHERE session_id = ? ORDER BY created_at",
        [sessionID],
      )
      if (rows.length === 0 || rows[0].values.length === 0) return

      this.goals = rows[0].values.map((row: any) => ({
        id: row[0],
        description: row[1],
        createdAt: row[2],
        status: row[3] as Goal["status"],
        satisfiedAt: row[4],
        timeoutMs: row[5] || 0,
        evaluations: row[6] ? JSON.parse(String(row[6])) : [],
      }))

      this.goalCounter = this.goals.length
      this.sessionID = sessionID
    } catch (err) {
      logError("[GoalJudge] Failed to load goals", err)
    }
  }

  /** 保存当前 goal 列表到 SQLite */
  async save(): Promise<void> {
    if (!this.sessionID) return
    try {
      // 先清除旧的 goal 记录
      runWrite("DELETE FROM goals WHERE session_id = ?", [this.sessionID])

      for (const goal of this.goals) {
        runWrite(
          `INSERT INTO goals (session_id, id, description, created_at, status, satisfied_at, timeout_ms, evaluations_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            this.sessionID,
            goal.id,
            goal.description,
            goal.createdAt,
            goal.status,
            goal.satisfiedAt,
            goal.timeoutMs,
            JSON.stringify(goal.evaluations),
          ],
        )
      }
    } catch (err) {
      logError("[GoalJudge] Failed to save goals", err)
    }
  }

  // ── CRUD ────────────────────────────────────────────

  setGoal(description: string, timeoutMs = 0): Goal {
    for (const goal of this.goals) {
      if (goal.status === "active") {
        goal.status = "cancelled"
      }
    }

    this.goalCounter++
    const goal: Goal = {
      id: `goal-${this.goalCounter}`,
      description,
      createdAt: new Date().toISOString(),
      status: "active",
      satisfiedAt: null,
      evaluations: [],
      timeoutMs,
    }

    this.goals.push(goal)
    this.save()
    return goal
  }

  getActiveGoal(): Goal | null {
    return this.goals.find(g => g.status === "active") || null
  }

  getAllGoals(): Goal[] {
    return [...this.goals]
  }

  cancelGoal(): boolean {
    const active = this.getActiveGoal()
    if (!active) return false
    active.status = "cancelled"
    this.save()
    return true
  }

  shouldContinue(goal: Goal): boolean {
    if (goal.status === "active" && this.isTimedOut(goal)) {
      goal.status = "timed_out"
      this.save()
      return false
    }
    return goal.status === "active"
  }

  // ── 超时 ────────────────────────────────────────────

  /** 检查 goal 是否超时 */
  isTimedOut(goal: Goal): boolean {
    if (goal.timeoutMs <= 0) return false
    const elapsed = Date.now() - new Date(goal.createdAt).getTime()
    return elapsed >= goal.timeoutMs
  }

  /** 获取超时剩余时间（毫秒），负数表示已超时 */
  getRemainingTime(goal: Goal): number {
    if (goal.timeoutMs <= 0) return Infinity
    const elapsed = Date.now() - new Date(goal.createdAt).getTime()
    return goal.timeoutMs - elapsed
  }

  // ── 评估 ────────────────────────────────────────────

  async evaluate(
    goal: Goal,
    messages: LLMMessage[],
    config?: GoalConfig,
  ): Promise<GoalEvaluation> {
    // 超时检测
    if (this.isTimedOut(goal)) {
      goal.status = "timed_out"
      this.save()
      return {
        timestamp: new Date().toISOString(),
        satisfied: false,
        reasoning: "Goal timed out before completion",
        confidence: 1,
      }
    }

    // 最大评估次数保护 — 防止无限循环
    if (goal.evaluations.length >= this.MAX_TOTAL_EVALS) {
      const last = goal.evaluations[goal.evaluations.length - 1]
      return {
        timestamp: new Date().toISOString(),
        satisfied: last.satisfied,
        reasoning: `Max evaluations (${this.MAX_TOTAL_EVALS}) reached. Last result: ${last.reasoning}`,
        confidence: last.confidence,
      }
    }

    const effectiveConfig = config || this.judgeConfig
    if (!effectiveConfig) {
      return {
        timestamp: new Date().toISOString(),
        satisfied: false,
        reasoning: "No judge model configured",
        confidence: 0,
      }
    }

    const evaluation: GoalEvaluation = {
      timestamp: new Date().toISOString(),
      satisfied: false,
      reasoning: "",
      confidence: 0,
    }

    try {
      const conversationText = this.formatConversation(messages)
      const evalMessages: LLMMessage[] = [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Goal: ${goal.description}`,
            "",
            `Previous evaluations:`,
            ...goal.evaluations.slice(-3).map(e =>
              `- ${e.timestamp}: ${e.satisfied ? "satisfied" : "not satisfied"} (confidence: ${e.confidence}) - ${e.reasoning}`
            ),
            "",
            `Conversation history:`,
            conversationText,
            "",
            `Determine if the goal has been fully achieved.`,
          ].join("\n"),
        },
      ]

      const client = createLLMClient({
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
        apiKey: effectiveConfig.apiKey,
        apiUrl: effectiveConfig.apiUrl,
      })

      let responseText = ""
      for await (const event of client.stream({ messages: evalMessages })) {
        if (event.type === "delta") {
          responseText += event.delta
        }
      }

      const parsed = this.parseJudgeResponse(responseText)
      evaluation.satisfied = parsed.satisfied
      evaluation.reasoning = parsed.reasoning
      evaluation.confidence = parsed.confidence
      evaluation.evidence = parsed.evidence
    } catch (err) {
      logError(`[GoalJudge] Evaluation failed for goal ${goal.id}`, err)
      evaluation.reasoning = `Evaluation error: ${String(err)}`
    }

    // 连续失败计数：不满足 → 计数+1；满足 → 重置
    if (evaluation.satisfied) {
      this.consecutiveFails = 0
    } else {
      this.consecutiveFails++
      if (this.consecutiveFails >= this.MAX_CONSECUTIVE_FAILS) {
        goal.evaluations.push(evaluation)
        goal.status = "failed"
        this.save()
        return { ...evaluation, reasoning: `${evaluation.reasoning} (auto-failed after ${this.MAX_CONSECUTIVE_FAILS} consecutive unsuccessful evaluations)` }
      }
    }

    // 增量评估：跳过重复结果相同的评估
    const lastEval = goal.evaluations[goal.evaluations.length - 1]
    if (lastEval && lastEval.satisfied === evaluation.satisfied && lastEval.reasoning === evaluation.reasoning) {
      // 结果与上次完全相同，跳过追加
      return lastEval
    }

    goal.evaluations.push(evaluation)
    if (evaluation.satisfied && evaluation.confidence >= 0.6) {
      goal.status = "satisfied"
      goal.satisfiedAt = evaluation.timestamp
    }

    this.save()
    return evaluation
  }

  quickCheck(goal: Goal, messages: LLMMessage[]): GoalEvaluation | null {
    const description = goal.description.toLowerCase()
    const lastMessages = messages.slice(-4)

    const allText = lastMessages
      .filter(m => m.role === "assistant" || m.role === "user")
      .map(m => typeof m.content === "string" ? m.content : "")
      .join(" ")

    const goalKeywords = description.split(/\s+/).filter(w => w.length > 3)
    const matchCount = goalKeywords.filter(kw => allText.includes(kw)).length
    const matchRatio = matchCount / goalKeywords.length

    const completionPhrases = [
      "已完成", "任务完成", "done", "completed", "finished",
      "已实现", "已部署", "已交付", "已提交",
    ]

    const hasCompletion = completionPhrases.some(p => allText.includes(p))
    const hasToolResult = lastMessages.some(m => m.role === "tool")

    if (hasCompletion && matchRatio > 0.6 && !hasToolResult) {
      return {
        timestamp: new Date().toISOString(),
        satisfied: true,
        reasoning: "Quick check: completion language detected with key terms matched",
        confidence: 0.7,
      }
    }

    return null
  }

  // ── 提示生成 ────────────────────────────────────────

  toSystemPrompt(): string {
    const active = this.getActiveGoal()
    if (!active) return ""

    const satisfied = active.evaluations.filter(e => e.satisfied).length
    const total = active.evaluations.length

    const parts = [
      `[Active Goal]`,
      `Description: ${active.description}`,
      `Status: ${active.status}`,
      `Evaluations: ${satisfied}/${total} satisfied`,
      total > 0
        ? `Last evaluation: ${active.evaluations[active.evaluations.length - 1].reasoning}`
        : "No evaluations yet",
    ]

    // 超时信息注入
    if (active.timeoutMs > 0) {
      const remaining = this.getRemainingTime(active)
      if (remaining > 0) {
        parts.push(`Time remaining: ${Math.ceil(remaining / 1000)}s`)
      }
    }

    parts.push(
      "",
      `[Goal Protocol]`,
      `When you believe the goal is complete, summarize what was done.`,
      `The system will then evaluate whether the goal has been fully achieved.`,
    )

    return parts.join("\n")
  }

  toText(): string {
    const lines: string[] = ["# Goals"]
    for (const goal of this.goals) {
      const icon = { active: "●", satisfied: "✓", failed: "✗", cancelled: "⊘", timed_out: "⏱" }[goal.status]
      lines.push(`\n## ${icon} ${goal.id}: ${goal.description}`)
      lines.push(`- Status: ${goal.status}`)
      lines.push(`- Created: ${goal.createdAt}`)
      if (goal.satisfiedAt) lines.push(`- Satisfied: ${goal.satisfiedAt}`)
      if (goal.timeoutMs > 0) {
        const remaining = this.getRemainingTime(goal)
        lines.push(`- Timeout: ${Math.ceil(goal.timeoutMs / 1000)}s (${remaining > 0 ? `${Math.ceil(remaining / 1000)}s remaining` : "expired"})`)
      }
      if (goal.evaluations.length > 0) {
        const last = goal.evaluations[goal.evaluations.length - 1]
        lines.push(`- Last evaluation: ${last.satisfied ? "satisfied" : "not satisfied"} (${last.confidence})`)
        lines.push(`  ${last.reasoning}`)
      }
    }
    return lines.join("\n")
  }

  // ── 内部 ────────────────────────────────────────────

  private formatConversation(messages: LLMMessage[]): string {
    return messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map(m => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        return `[${m.role}]: ${content.slice(0, 600)}`
      })
      .join("\n\n")
  }

  private parseJudgeResponse(response: string): {
    satisfied: boolean
    reasoning: string
    confidence: number
    evidence?: string[]
  } {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
        const rawReasoning = parsed.reasoning
        const reasoning = typeof rawReasoning === "string"
          ? rawReasoning
          : typeof rawReasoning === "object" && rawReasoning !== null
            ? JSON.stringify(rawReasoning)
            : String(rawReasoning)
        return {
          satisfied: Boolean(parsed.satisfied),
          reasoning,
          confidence: Number(parsed.confidence) || 0,
          evidence: Array.isArray(parsed.evidence)
            ? parsed.evidence.map((e) => String(e)).slice(0, 10)
            : undefined,
        }
      }
    } catch {
      // JSON 解析失败，回退到关键词检测
    }

    const satisfied = /satisfied|achieved|completed|done|yes|true/i.test(response)
    return {
      satisfied,
      reasoning: response.slice(0, 500),
      confidence: satisfied ? 0.5 : 0,
    }
  }
}


