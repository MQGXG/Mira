import {
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
} from "../components/assistant-ui/reasoning";
import { Loader2 } from "lucide-react";

interface ReasoningBlockProps {
  text: string;
  /** 推理时间区间（结束时有 end，用于显示时长） */
  time?: { start: number; end?: number };
  /** 是否默认展开（默认 false=折叠，参考 OpenCode 默认折叠思考过程） */
  defaultOpen?: boolean;
  /** 流式生成中（正在思考） */
  active?: boolean;
}

/** LLM 推理内容块 — 折叠面板，完成后显示耗时（对齐 opencode ReasoningPartDisplay） */
export function ReasoningBlock({ text, time, defaultOpen = false, active = false }: ReasoningBlockProps) {
  if (!text) return null;

  const duration = time?.end ? Math.round((time.end - time.start) / 1000) : undefined;

  return (
    <ReasoningRoot variant="muted" defaultOpen={defaultOpen}>
      <ReasoningTrigger active={active} duration={duration} />
      <ReasoningContent>
        <ReasoningText>
          {text}
        </ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}

/** Thinking shimmer — 等待第一个 reasoning token 时显示（对齐 opencode TextShimmer "Thinking"） */
export function ThinkingShimmer() {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm" style={{ color: "var(--fg-tertiary)" }}>
      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
      <span>Thinking...</span>
    </div>
  );
}

/** 兼容旧名 — 系统 thinking 消息不再渲染为 Reasoning 块，改为不显示 */
export function ThinkingBlock() {
  return null;
}
