export type ToolCallStatus = "running" | "done" | "error";

export interface CompactionData {
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface MiraPart {
  type: "text" | "thinking" | "reasoning" | "tool-call" | "file" | "diff-summary" | "compaction" | "widget";
  /** text / thinking / widget */
  text?: string;
  /** reasoning */
  reasoningId?: string;
  /** reasoning 时间区间 */
  time?: { start: number; end?: number };
  /** widget：iframe 渲染的富 HTML 内容 */
  html?: string;
  /** tool-call */
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  status?: ToolCallStatus;
  result?: string;
  snapshotId?: string;
  /** file */
  mime?: string;
  url?: string;
  name?: string;
  /** 文件类型（text/excel/word/ppt 等路径引用卡片） */
  kind?: string;
  /** 原始文件路径（路径引用） */
  path?: string;
  /** diff-summary */
  files?: DiffFileEntry[];
  /** compaction */
  compaction?: CompactionData;
}

export interface DiffFileEntry {
  filePath: string;
  additions: number;
  deletions: number;
  oldContent: string;
  newContent: string;
}

export interface MessageTiming {
  streamStartTime: number;
  firstTokenTime?: number;
  totalStreamTime?: number;
  tokenCount?: number;
  /** 真实 prompt tokens（来自 LLM API） */
  promptTokens?: number;
  /** 真实 completion tokens（来自 LLM API） */
  completionTokens?: number;
  /** 命中缓存的 prompt tokens（来自 LLM API） */
  cacheReadTokens?: number;
  /** 写入缓存的 prompt tokens（来自 LLM API） */
  cacheWriteTokens?: number;
  tokensPerSecond?: number;
  totalChunks: number;
  toolCallCount: number;
}

export interface MiraMessage {
  id: string;
  role: "user" | "assistant";
  parts: MiraPart[];
  dbId?: number;
  createdAt?: Date;
  timing?: MessageTiming;
  retryCount?: number;
  /** 消息级错误（模型失败等） */
  error?: string;
}
