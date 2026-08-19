import { z } from "zod"

export type MessageRole = "system" | "user" | "assistant" | "tool"

export const TextPartSchema = z.object({ type: z.literal("text"), text: z.string() })
export type TextPart = z.infer<typeof TextPartSchema>

export const ReasoningPartSchema = z.object({ type: z.literal("reasoning"), text: z.string() })
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>

export const ToolCallPartSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.string(), z.any()),
})
export type ToolCallPart = z.infer<typeof ToolCallPartSchema>

export const ToolResultPartSchema = z.object({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.union([z.string(), z.object({ type: z.literal("text"), value: z.string() })]),
})
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>

export const ImagePartSchema = z.object({
  type: z.literal("image"),
  /** data URL（base64）或远程 URL */
  image: z.string(),
  /** 图片 MIME 类型（data URL 时可由前缀推导） */
  mediaType: z.string().optional(),
})
export type ImagePart = z.infer<typeof ImagePartSchema>

export const ContentPartSchema = z.union([
  TextPartSchema,
  ReasoningPartSchema,
  ImagePartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
])
export type ContentPart = z.infer<typeof ContentPartSchema>

export interface LLMMessage {
  role: MessageRole
  content: string | ContentPart[]
  tool_call_id?: string
  /**
   * DeepSeek thinking 模型的思考内容（reasoning_content）。
   * 注意：DeepSeek API 要求上一轮 assistant 的 reasoning_content 必须原样回传，
   * 否则返回 HTTP 400 "The reasoning_content in the thinking mode must be passed back to the API."
   */
  reasoning_content?: string
}

export type ToolResultOutput = string | { type: "text"; value: string }

export function getToolResultOutput(output: ToolResultOutput): string {
  return typeof output === "string" ? output : output.value
}

export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === "text"
}

export function isImagePart(part: ContentPart): part is ImagePart {
  return part.type === "image"
}

export function isToolCallPart(part: ContentPart): part is ToolCallPart {
  return part.type === "tool-call"
}

export function isToolResultPart(part: ContentPart): part is ToolResultPart {
  return part.type === "tool-result"
}

export function isReasoningPart(part: ContentPart): part is ReasoningPart {
  return part.type === "reasoning"
}
