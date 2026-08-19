/**
 * 追问建议生成 — 用 LLM 基于对话上下文生成 follow-up 追问建议
 *
 * 参考 MiMo-Code 的 session.predict（LLM 生成建议），对 Mira 的 Web chat 形态，
 * 在回复完成后由模型生成 2-3 条贴合对话（含日常问答）的追问。
 */

import { createLLMClient, type LLMMessage } from "./client"

export interface FollowUpLLMConfig {
  apiKey: string
  apiUrl: string
  model: string
  provider: string
}

const FOLLOWUP_SYSTEM = `You are a helpful assistant. Based on the most recent conversation, suggest 2 to 3 short follow-up questions the user would naturally want to ask next.

Rules:
- Keep each question under 40 characters.
- Questions must relate to the conversation topics (coding, daily Q&A, analysis, etc.).
- Prefer natural continuations: clarifying, deepening, examples, alternatives, or next steps.
- Respond with ONLY a JSON array of strings, no markdown, e.g. ["question 1", "question 2", "question 3"].`

/** 用 LLM 生成追问建议；失败时返回空数组（由调用方降级到启发式） */
export async function generateFollowUpSuggestions(
  conversation: LLMMessage[],
  config: FollowUpLLMConfig,
): Promise<string[]> {
  try {
    const client = createLLMClient({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      apiUrl: config.apiUrl,
      // 成本控制：追问建议很短，限制输出 + 偏低温度保持稳定
      options: { maxTokens: 200, temperature: 0.5 },
    })
    const messages: LLMMessage[] = [
      { role: "system", content: FOLLOWUP_SYSTEM },
      ...conversation.slice(-8),
    ]
    let text = ""
    for await (const event of client.stream({ messages })) {
      if (event.type === "delta") text += event.delta
    }
    const cleaned = text.replace(/```(?:json)?\n?/g, "").trim()
    const parsed = JSON.parse(cleaned)
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string").slice(0, 3)
    }
    return []
  } catch {
    return []
  }
}
