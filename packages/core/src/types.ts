import type { ToolCall } from './shared/tool'

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type FinishReason = "stop" | "length" | "tool-calls" | "error" | "content-filtered" | "unknown"

export type EventType =
  | "content" | "tool_start" | "tool_result"
  | "permission_request" | "question" | "error" | "finish"
  | "thinking" | "reasoning-start" | "reasoning-delta" | "reasoning-end" | "goal_status" | "context_rebuild" | "retry" | "subagent_status"

export interface BaseAgentEvent {
  timestamp?: string
}

export interface ContentEvent extends BaseAgentEvent { type: "content"; text: string }
export interface ToolStartEvent extends BaseAgentEvent { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
export interface ToolResultEvent extends BaseAgentEvent { type: "tool_result"; id: string; name: string; result: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> } }
export interface PermissionRequestEvent extends BaseAgentEvent { type: "permission_request"; id: string; action: string; resources: string[]; toolCall: ToolCall }
export interface QuestionEvent extends BaseAgentEvent { type: "question"; id: string; question: string; options?: string[] }
export interface ErrorEvent extends BaseAgentEvent { type: "error"; message: string }
export interface FinishEvent extends BaseAgentEvent { type: "finish"; reason: string; usage?: TokenUsage }
export interface ThinkingEvent extends BaseAgentEvent { type: "thinking"; text: string }
export interface ReasoningStartEvent extends BaseAgentEvent { type: "reasoning-start"; id: string }
export interface ReasoningDeltaEvent extends BaseAgentEvent { type: "reasoning-delta"; id: string; text: string }
export interface ReasoningEndEvent extends BaseAgentEvent { type: "reasoning-end"; id: string }
export interface GoalStatusEvent extends BaseAgentEvent { type: "goal_status"; goalId: string; description: string; status: string; reasoning?: string }
export interface ContextRebuildEvent extends BaseAgentEvent { type: "context_rebuild"; reason: string; tokensBefore: number; tokensAfter: number }
export interface RetryEvent extends BaseAgentEvent { type: "retry"; attempt: number; error: string }
export interface SubagentStatusEvent extends BaseAgentEvent { type: "subagent_status"; subagentId: string; status: string; description: string }

export type AgentEvent =
  | ContentEvent
  | ToolStartEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | QuestionEvent
  | ErrorEvent
  | FinishEvent
  | ThinkingEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | GoalStatusEvent
  | ContextRebuildEvent
  | RetryEvent
  | SubagentStatusEvent
