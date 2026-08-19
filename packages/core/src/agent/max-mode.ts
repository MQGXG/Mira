import { createLLMClient, type LLMToolSet, type LLMMessage } from "../llm/client"
import type { AgentEvent } from "../types"
import { runLLMTurn, type LLMTurnConfig } from "./turn"
import { detectTextNgramRepeat } from "./utils"
import { sanitizeMessagesForLLM } from "../shared/message-utils"

export interface MaxModeConfig {
  n: number
  candidateConfig: LLMTurnConfig
  judgeConfig?: LLMTurnConfig
}

export interface MaxModeInput {
  messages: LLMMessage[]
  tools: LLMToolSet
  config: MaxModeConfig
  signal?: AbortSignal
}

export interface MaxModeOutput {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  winner: number
  totalCandidates: number
}

const JUDGE_SYSTEM_PROMPT = `You are an impartial judge evaluating AI responses.
Compare the following candidate responses and select the best one.

Criteria:
1. Correctness — does it actually solve the user's problem?
2. Completeness — does it cover all requirements?
3. Efficiency — does it avoid unnecessary steps?
4. Safety — does it avoid dangerous operations?

Respond with ONLY the candidate number (0, 1, 2, etc.) that is best.
If tied, prefer the one that is more conservative and safe.`

const MAX_CANDIDATE_RETRIES = 2
const MAX_JUDGE_RETRIES = 2

interface CandidateResult {
  text: string
  toolCalls: Array<{ id: string; name: string; arguments: string }>
  index: number
}

async function runCandidate(
  input: { messages: LLMMessage[]; tools: LLMToolSet; config: LLMTurnConfig },
  _index: number,
): Promise<CandidateResult | null> {
  for (let attempt = 0; attempt <= MAX_CANDIDATE_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)))
    }
    try {
      const client = createLLMClient({
        provider: input.config.provider,
        model: input.config.model,
        apiKey: input.config.apiKey,
        apiUrl: input.config.apiUrl,
        headers: input.config.headers,
        options: input.config.options,
      })

      const stream = client.stream({ messages: sanitizeMessagesForLLM(input.messages), tools: input.tools })
      let text = ""
      const toolCalls: Array<{ id: string; name: string; arguments: string }> = []
      let ngramWindow = ""
      let textRepeat = false

      for await (const event of stream) {
        if (event.type === "delta") {
          text += event.delta
          ngramWindow += event.delta
          if (ngramWindow.length > 100) ngramWindow = ngramWindow.slice(-100)
          if (detectTextNgramRepeat(ngramWindow)) {
            textRepeat = true
            break
          }
        } else if (event.type === "tool_call" && event.toolCall) {
          toolCalls.push({
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
          })
        } else if (event.type === "error") {
          throw new Error(event.error?.message || "Candidate stream error")
        } else if (event.type === "done") {
          break
        }
      }

      if (textRepeat) return null
      return { text, toolCalls, index: _index }
    } catch {
      if (attempt >= MAX_CANDIDATE_RETRIES) return null
    }
  }
  return null
}

async function judgeCandidates(
  candidates: CandidateResult[],
  userMessage: string,
  config: LLMTurnConfig,
): Promise<number> {
  const rendered = candidates.map((c, i) => {
    const toolText = c.toolCalls.map(tc => `  → ${tc.name}(${tc.arguments.slice(0, 200)})`).join("\n")
    return `[Candidate ${i}]\n${c.text.slice(0, 1000)}\n${toolText ? `\nTools:\n${toolText}` : ""}`
  }).join("\n\n---\n\n")

  const judgeMessages: LLMMessage[] = [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    { role: "user", content: `User request: ${userMessage}\n\n${rendered}\n\nWhich candidate is best? Respond with only the number.` },
  ]

  for (let attempt = 0; attempt <= MAX_JUDGE_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)))
    }
    try {
      const client = createLLMClient({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        apiUrl: config.apiUrl,
      })
      const result = await client.complete({ messages: judgeMessages, tools: {} })
      const num = parseInt(result.content.trim(), 10)
      if (!isNaN(num) && num >= 0 && num < candidates.length) return num
    } catch { /* retry */ }
  }
  return 0
}

export async function* runMaxMode(
  input: MaxModeInput,
): AsyncGenerator<AgentEvent, MaxModeOutput> {
  const { messages, tools, config } = input
  const n = Math.max(2, Math.min(config.n || 3, 8))
  const judgeModel = config.judgeConfig || config.candidateConfig

  yield { type: "thinking" as const, text: `🧠 Max Mode: generating ${n} candidates in parallel...` }

  const startTime = Date.now()

  const promises = Array.from({ length: n }, (_, i) =>
    runCandidate({ messages, tools, config: config.candidateConfig }, i),
  )

  const results = await Promise.all(promises)
  const candidates = results.filter((r): r is CandidateResult => r !== null)

  if (candidates.length === 0) {
    yield { type: "thinking" as const, text: "⚠️ All candidates failed, falling back to single LLM call" }
    const fallback = yield* runLLMTurn({
      messages,
      tools,
      config: config.candidateConfig,
    })
    return {
      text: fallback.text,
      toolCalls: fallback.toolCalls,
      winner: 0,
      totalCandidates: 0,
    }
  }

  const elapsed = Date.now() - startTime
  yield { type: "thinking" as const, text: `🧠 ${candidates.length}/${n} candidates completed in ${elapsed}ms. Judging...` }

  const winnerIndex = await judgeCandidates(candidates, getLastUserMessage(messages), judgeModel)

  const winner = candidates[winnerIndex]
  yield { type: "thinking" as const, text: `✨ Candidate ${winnerIndex} selected (${candidates.length} candidates, ${elapsed}ms)` }

  return {
    text: winner.text,
    toolCalls: winner.toolCalls,
    winner: winnerIndex,
    totalCandidates: candidates.length,
  }
}

function getLastUserMessage(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === "user") {
      return typeof m.content === "string" ? m.content : ""
    }
  }
  return ""
}

