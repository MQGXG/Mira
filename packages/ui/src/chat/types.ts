export type ToolCallStatus = "running" | "done" | "error";

export interface ToolCallInfo {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: ToolCallStatus;
}

export type AgentMode = "assistant" | "expert" | "action" | "safe" | "plan";
