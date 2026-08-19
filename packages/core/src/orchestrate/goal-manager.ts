/**
 * @deprecated 由 GoalJudge (goal-judge.ts) 替代
 *
 * 此文件是 GoalJudge 的早期实现，现已被 GoalJudge 完全替代。
 * GoalJudge 提供了：
 * - 相同的 CRUD API（setGoal/getActiveGoal/getAllGoals/cancelGoal）
 * - 改进的评估逻辑（流式 LLM、confidence 阈值、三层降级解析）
 * - quickCheck 快速预检（避免每次评估都调用 LLM）
 * - 深度集成到 agent 循环（agent.ts 中使用 GoalJudge）
 *
 * 请使用 GoalJudge 替代，此文件将在下一轮清理中移除。
 */

import { createLLMClient, type LLMMessage } from "../llm/client"
import { logError } from "../system/logger"

export interface GoalCondition {
  id: string
  description: string
  createdAt: string
  status: "active" | "satisfied" | "failed" | "cancelled"
  satisfiedAt: string | null
  evaluationHistory: GoalEvaluation[]
}

export interface GoalEvaluation {
  timestamp: string
  satisfied: boolean
  reasoning: string
  events: string[]
}

interface GoalStore {
  goals: GoalCondition[]
}

const JUDGE_SYSTEM_PROMPT = `You are a goal evaluation judge. Your task is to evaluate whether a goal has been satisfied based on the conversation history.

Given:
1. A goal description
2. The conversation history (user messages and assistant responses)

Determine:
- Whether the goal has been achieved (true/false)
- A brief reasoning for your decision
- Key events that indicate progress toward the goal

Respond in JSON format:
{
  "satisfied": true/false,
  "reasoning": "Brief explanation",
  "events": ["event1", "event2"]
}`

export class GoalManager {
  private goals: GoalCondition[] = []
  private goalCounter = 0

  /**
   * 设置新的 goal
   */
  setGoal(description: string): GoalCondition {
    // 取消之前活跃的 goal
    for (const goal of this.goals) {
      if (goal.status === "active") {
        goal.status = "cancelled"
      }
    }

    this.goalCounter++
    const goal: GoalCondition = {
      id: `goal-${this.goalCounter}`,
      description,
      createdAt: new Date().toISOString(),
      status: "active",
      satisfiedAt: null,
      evaluationHistory: [],
    }

    this.goals.push(goal)
    return goal
  }

  /**
   * 获取当前活跃的 goal
   */
  getActiveGoal(): GoalCondition | null {
    return this.goals.find(g => g.status === "active") || null
  }

  /**
   * 获取所有 goal
   */
  getAllGoals(): GoalCondition[] {
    return [...this.goals]
  }

  /**
   * 取消当前 goal
   */
  cancelGoal(): boolean {
    const active = this.getActiveGoal()
    if (!active) return false
    active.status = "cancelled"
    return true
  }

  /**
   * 评估 goal 是否满足
   * 使用独立的 LLM 裁判模型进行评估
   */
  async evaluateGoal(
    goal: GoalCondition,
    conversationHistory: LLMMessage[],
    config: { apiKey: string; apiUrl: string; model: string; provider: string }
  ): Promise<GoalEvaluation> {
    const evaluation: GoalEvaluation = {
      timestamp: new Date().toISOString(),
      satisfied: false,
      reasoning: "",
      events: [],
    }

    try {
      // 构建评估消息
      const evalMessages: LLMMessage[] = [
        {
          role: "system",
          content: JUDGE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: `Goal: ${goal.description}\n\nConversation history:\n${this.formatConversation(conversationHistory)}\n\nEvaluate whether this goal has been achieved.`,
        },
      ]

      // 使用配置的模型进行评估
      const client = createLLMClient({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
      })

      let responseText = ""
      for await (const event of client.stream({ messages: evalMessages })) {
        if (event.type === "delta") {
          responseText += event.delta
        }
      }

      // 解析评估结果
      const parsed = this.parseEvaluationResponse(responseText)
      evaluation.satisfied = parsed.satisfied
      evaluation.reasoning = parsed.reasoning
      evaluation.events = parsed.events
    } catch (err) {
      logError(`[GoalManager] Evaluation failed for goal ${goal.id}`, err)
      evaluation.reasoning = `Evaluation failed: ${String(err)}`
    }

    // 记录评估历史
    goal.evaluationHistory.push(evaluation)

    // 如果满足，更新状态
    if (evaluation.satisfied) {
      goal.status = "satisfied"
      goal.satisfiedAt = evaluation.timestamp
    }

    return evaluation
  }

  /**
   * 检查 agent 是否应该继续工作
   * 如果有活跃的 goal 且未满足，agent 应该继续
   */
  shouldContinue(goal: GoalCondition): boolean {
    return goal.status === "active"
  }

  /**
   * 生成 goal 状态的系统提示
   */
  toSystemPrompt(): string {
    const active = this.getActiveGoal()
    if (!active) return ""

    const satisfiedCount = active.evaluationHistory.filter(e => e.satisfied).length
    const totalEvaluations = active.evaluationHistory.length

    return (
      `[Active goal: ${active.id}]\n` +
      `Goal: ${active.description}\n` +
      `Status: ${active.status}\n` +
      `Evaluations: ${satisfiedCount}/${totalEvaluations} satisfied\n` +
      (active.evaluationHistory.length > 0
        ? `Last evaluation: ${active.evaluationHistory[active.evaluationHistory.length - 1].reasoning}`
        : "No evaluations yet")
    )
  }

  /**
   * 生成 goal 状态的文本
   */
  toText(): string {
    const lines: string[] = ["# Goals"]

    for (const goal of this.goals) {
      const statusIcon = {
        active: "●",
        satisfied: "✓",
        failed: "✗",
        cancelled: "⊘",
      }[goal.status]

      lines.push(`\n## ${statusIcon} ${goal.id}: ${goal.description}`)
      lines.push(`- Status: ${goal.status}`)
      lines.push(`- Created: ${goal.createdAt}`)
      if (goal.satisfiedAt) {
        lines.push(`- Satisfied: ${goal.satisfiedAt}`)
      }
      if (goal.evaluationHistory.length > 0) {
        lines.push(`- Evaluations: ${goal.evaluationHistory.length}`)
        const last = goal.evaluationHistory[goal.evaluationHistory.length - 1]
        lines.push(`- Last: ${last.satisfied ? "satisfied" : "not satisfied"} - ${last.reasoning}`)
      }
    }

    return lines.join("\n")
  }

  private formatConversation(messages: LLMMessage[]): string {
    return messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => {
        const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        return `[${m.role}]: ${content.slice(0, 500)}`
      })
      .join("\n")
  }

  private parseEvaluationResponse(response: string): {
    satisfied: boolean
    reasoning: string
    events: string[]
  } {
    try {
      // 尝试解析 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        return {
          satisfied: Boolean(parsed.satisfied),
          reasoning: String(parsed.reasoning || ""),
          events: Array.isArray(parsed.events) ? parsed.events : [],
        }
      }
    } catch {
      // JSON 解析失败，使用简单的关键词检测
    }

    // 简单的关键词检测
    const satisfied = /satisfied|achieved|completed|done|yes|true/i.test(response)
    const reasoning = response.slice(0, 500)

    return { satisfied, reasoning, events: [] }
  }
}


