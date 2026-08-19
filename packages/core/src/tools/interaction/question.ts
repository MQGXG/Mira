/**
 * Question 工具 — 向用户提问
 * 参考 OpenCode/MiMo 的 question.ts
 *
 * 用途：Agent 需要用户输入时调用（非权限审批，而是主动提问）
 * 例如：选择方案 A/B、确认操作、获取额外信息
 */

import { z } from "zod"
import { make, RecoverableError } from "../../shared/tool"

/** 存储待回答的问题 */
const pendingQuestions = new Map<string, {
  question: string
  options: string[]
  resolve: (answer: string) => void
  reject: (error: Error) => void
  createdAt: number
}>()

/** 超时：5 分钟 */
const QUESTION_TIMEOUT = 5 * 60 * 1000

/**
 * 由 IPC 层调用：用户回答问题
 */
export function answerQuestion(questionId: string, answer: string): boolean {
  const pending = pendingQuestions.get(questionId)
  if (!pending) return false
  pendingQuestions.delete(questionId)
  pending.resolve(answer)
  return true
}

/**
 * 获取所有待回答的问题（供 UI 展示）
 */
export function getPendingQuestions() {
  const now = Date.now()
  const results: Array<{ id: string; question: string; options: string[]; createdAt: number }> = []
  for (const [id, q] of pendingQuestions) {
    if (now - q.createdAt > QUESTION_TIMEOUT) {
      q.reject(new Error("Question timed out"))
      pendingQuestions.delete(id)
      continue
    }
    results.push({ id, question: q.question, options: q.options, createdAt: q.createdAt })
  }
  return results
}

export const questionTool = make({
  name: "question",
  description: "Ask the user a question to get their input or make a decision. Use when you need clarification, want to confirm an approach, or need the user to choose between options.",
  inputSchema: z.object({
    question: z.string().describe("The question to ask the user"),
    options: z.array(z.string()).optional().describe("Optional list of choices for the user to pick from"),
  }),
  outputSchema: z.string(),
  permission: "question",

  async execute(input, ctx) {
    const questionId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    // 创建 Promise 等待用户回答
    const answer = await new Promise<string>((resolve, reject) => {
      pendingQuestions.set(questionId, {
        question: input.question,
        options: input.options || [],
        resolve,
        reject,
        createdAt: Date.now(),
      })

      // 超时处理
      setTimeout(() => {
        if (pendingQuestions.has(questionId)) {
          pendingQuestions.delete(questionId)
          reject(new Error("Question timed out after 5 minutes"))
        }
      }, QUESTION_TIMEOUT)
    })

    return {
      success: true,
      output: `User answered: ${answer}`,
      metadata: { questionId, question: input.question, answer },
    }
  },
})

