/**
 * 流式事件处理 — 从 useMiraChat 拆出，职责单一
 *
 * 消费 Agent 流式事件并更新聊天 UI 状态：
 * - 文本增量缓冲（requestAnimationFrame 批量刷新）
 * - 工具调用/思考/权限/提问/错误/完成等事件分发
 */

import type { Dispatch, SetStateAction } from "react";
import type { AgentEvent } from "../services/agent.service";
import type { AgentService } from "../services/agent.service";
import {
  createMiraMessage,
  appendText,
  appendThinking,
  appendReasoning,
  finishReasoning,
  addToolCall,
  updateToolCall,
  addCompaction,
  type MiraMessage,
  type MiraPart,
} from "../chat/mira-runtime";
import { loadSettings as getSettings } from "../sidebar/provider-data";
import { extractWidgetBlocks } from "../components/assistant-ui/widget-renderer";

/**
 * 从 assistant 消息的 text parts 中提取 widget 代码块，转为独立 widget part。
 * 保留清洗后的文本（不含 widget 代码），widget HTML 单独渲染。
 */
function extractWidgetsFromMessage(message: MiraMessage): MiraMessage {
  const newParts: MiraPart[] = [];
  let hasWidget = false;

  for (const part of message.parts) {
    if (part.type === "text" && part.text) {
      const { cleanText, widgets } = extractWidgetBlocks(part.text);
      if (widgets.length > 0) {
        hasWidget = true;
        if (cleanText) {
          newParts.push({ ...part, text: cleanText });
        }
        for (const html of widgets) {
          newParts.push({ type: "widget", html, text: "widget" });
        }
      } else {
        newParts.push(part);
      }
    } else {
      newParts.push(part);
    }
  }

  return hasWidget ? { ...message, parts: newParts } : message;
}

/** AgentService 延迟注入（由 useMiraChat 初始化，避免循环依赖） */
let agentService: typeof AgentService | null = null;

export function setAgentService(service: typeof AgentService): void {
  agentService = service;
}

export interface StreamEventContext {
  setMessages: Dispatch<SetStateAction<MiraMessage[]>>;
  setIsRunning: Dispatch<SetStateAction<boolean>>;
  clearCurrentChannel: () => void;
  /** 真实会话 ID（用于会话标题更新等，channel 是随机流标识不等同于 sessionId） */
  sessionId?: string;
  setPermissionReq: Dispatch<SetStateAction<{
    tool_name: string;
    args: Record<string, unknown>;
    reason: string;
    request_id: string;
    channel?: string;
  } | null>>;
  setQuestionReq: Dispatch<SetStateAction<{
    question: string;
    options: string[];
    request_id: string;
  } | null>>;
  setLiveTiming: Dispatch<SetStateAction<{
    streamStartTime: number;
    firstTokenTime?: number;
    tokenCount: number;
    chunkCount: number;
    toolCallCount: number;
  } | null>>;
  timingRef: React.MutableRefObject<{
    streamStartTime: number;
    firstTokenTime?: number;
    tokenCount: number;
    chunkCount: number;
    toolCallCount: number;
  } | null>;
}

/** 基于 requestAnimationFrame 的文本缓冲刷新 */
export function createContentBuffer(
  assistantId: string,
  ctx: StreamEventContext
): { append: (text: string) => void; flush: () => void } {
  let buffer = "";
  let rafId: number | null = null;

  function flush() {
    rafId = null;
    if (!buffer) return;
    const text = buffer;
    buffer = "";
    const { setMessages } = ctx;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), appendText(last, text)];
      }
      return [...prev, createMiraMessage("assistant", text, assistantId)];
    });
  }

  return {
    append(text: string) {
      buffer += text;
      if (!rafId) rafId = requestAnimationFrame(flush);
    },
    flush() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      flush();
    },
  };
}

const contentBuffers = new Map<string, ReturnType<typeof createContentBuffer>>();

/** 清空所有流式文本缓冲（暂停/中断时调用，避免残留缓冲在下次渲染时闪现） */
export function clearContentBuffers(): void {
  contentBuffers.forEach((buf) => buf.flush());
  contentBuffers.clear();
}

/** 仅清空指定 channel 的文本缓冲（多会话并发时避免互相清空） */
export function clearChannelBuffer(channel: string): void {
  const buf = contentBuffers.get(channel);
  if (buf) {
    buf.flush();
    contentBuffers.delete(channel);
  }
}

export function handleStreamEvent(
  event: AgentEvent,
  channel: string,
  assistantId: string,
  ctx: StreamEventContext
): void {
  const { setMessages, setIsRunning, clearCurrentChannel, setPermissionReq, setQuestionReq, setLiveTiming, timingRef } = ctx;

  if (event.type === "content") {
    const t = timingRef.current;
    if (t) {
      if (!t.firstTokenTime) t.firstTokenTime = Date.now();
      t.tokenCount += event.text.split(/\s+/).filter(Boolean).length;
      t.chunkCount++;
      setLiveTiming({ ...t });
    }
    let buf = contentBuffers.get(channel);
    if (!buf) {
      buf = createContentBuffer(assistantId, ctx);
      contentBuffers.set(channel, buf);
    }
    buf.append(event.text);
  } else if (event.type === "tool_start") {
    contentBuffers.get(channel)?.flush();
    const t = timingRef.current;
    if (t) {
      t.toolCallCount++;
      setLiveTiming({ ...t });
    }
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), addToolCall(last, event.id, event.name, event.args)];
      }
      const newMsg = createMiraMessage("assistant", [], assistantId);
      return [...prev, addToolCall(newMsg, event.id, event.name, event.args)];
    });
  } else if (event.type === "reasoning-start") {
    contentBuffers.get(channel)?.flush();
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), appendReasoning(last, event.id, "")];
      }
      const newMsg = createMiraMessage("assistant", [], assistantId);
      return [...prev, appendReasoning(newMsg, event.id, "")];
    });
  } else if (event.type === "reasoning-delta") {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), appendReasoning(last, event.id, event.text)];
      }
      return prev;
    });
  } else if (event.type === "reasoning-end") {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), finishReasoning(last, event.id)];
      }
      return prev;
    });
  } else if (event.type === "thinking") {
    contentBuffers.get(channel)?.flush();
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), appendThinking(last, event.text)];
      }
      return prev;
    });
  } else if (event.type === "tool_result") {
    contentBuffers.get(channel)?.flush();
    const status = event.result.success ? "done" as const : "error" as const;
    const resultText = event.result.output || event.result.error || "";
    const snapshotId = (event.result as any).metadata?.snapshotId as string | undefined;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), updateToolCall(last, event.id, status, resultText, snapshotId)];
      }
      return prev;
    });
  } else if (event.type === "permission_request") {
    const s = getSettings();
    if (s.autoAcceptPermissions) {
      agentService?.replyPermission(channel, event.id, "allow");
    } else {
      setPermissionReq({
        tool_name: event.action,
        args: event.toolCall?.input || {},
        reason: `需要权限执行操作: ${event.action}`,
        request_id: event.id,
        channel,
      });
    }
  } else if (event.type === "question") {
    // 校验 options 为字符串数组（LLM 可能传非法值）
    const opts = Array.isArray(event.options)
      ? event.options.filter((o) => typeof o === "string")
      : [];
    setQuestionReq({
      question: event.question,
      options: opts,
      request_id: event.id,
    });
  } else if (event.type === "error") {
    const raw = event.message || "";
    const cleanMsg = raw
      .replace(/\[TOOL_ERROR\]\s*/g, "")
      .replace(/\s*\{.*\}/s, "")
      .trim();
    const lower = raw.toLowerCase();
    let hint = "";
    if (lower.includes("401")) hint = "API Key 无效，请在设置中检查";
    else if (lower.includes("400") && (lower.includes("api key") || lower.includes("apikey") || lower.includes("token"))) hint = "API Key 格式错误，请在设置中重新配置";
    else if (lower.includes("400") && (lower.includes("tool") || lower.includes("message") || lower.includes("context"))) hint = "消息序列异常（可能是历史工具调用记录损坏）。建议新建会话，或删除该会话重新开始。";
    else if (lower.includes("400") || lower.includes("bad request")) hint = "请求参数错误，检查模型名/Provider 配置是否正确";
    else if (lower.includes("402")) hint = "账户余额不足，请检查 API 计费";
    else if (lower.includes("429")) hint = "请求过于频繁，请稍后重试";
    else if (lower.includes("500") || lower.includes("502") || lower.includes("503")) hint = "服务端暂时不可用，请稍后重试";
    const errorText = `⚠️ ${cleanMsg || raw}${hint ? `\n\n💡 ${hint}` : ""}`;
    // 更新原消息而非追加新消息，避免半截内容与错误信息错位
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        return [...prev.slice(0, -1), { ...last, parts: [...last.parts, { type: "text" as const, text: errorText }], error: cleanMsg || raw }];
      }
      return [...prev, createMiraMessage("assistant", errorText, assistantId)];
    });
    contentBuffers.get(channel)?.flush();
    contentBuffers.delete(channel);
    setLiveTiming(null);
    setIsRunning(false);
    clearCurrentChannel();
  } else if (event.type === "retry") {
    contentBuffers.get(channel)?.flush();
    const attempt = event.attempt;
    const errMsg = event.error;
    ctx.setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.id === assistantId) {
        const retryMark = `🔄 重试 #${attempt}: ${errMsg.length > 60 ? errMsg.slice(0, 60) + "..." : errMsg}`;
        return [
          ...prev.slice(0, -1),
          { ...last, parts: [...last.parts, { type: "text" as const, text: retryMark }], retryCount: attempt },
        ];
      }
      return prev;
    });
  } else if (event.type === "finish") {
    // 第一条消息完成后自动生成会话标题（用真实 sessionId，channel 是随机流标识）
    const targetSession = ctx.sessionId || channel;
    if (targetSession && !targetSession.startsWith("offline-")) {
      ctx.setMessages((prev) => {
        const isFirstTurn = prev.length <= 2;
        if (isFirstTurn) {
          const userText = prev.find((m: any) => m.role === "user")?.parts?.[0]?.text || "";
          if (userText) {
            const title = userText.replace(/[\n\r]/g, " ").trim().slice(0, 50);
            import("../services/session.service").then(({ SessionService }) => {
              SessionService.update(targetSession, { title }).catch(() => {});
            }).catch(() => {});
          }
        }
        return prev;
      });
    }

    const t = timingRef.current;
    const usage = event.usage;

    // 提取 widget 代码块（```html ... ```）→ 转为独立 widget part，隐藏原始代码
    contentBuffers.get(channel)?.flush();
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [...prev.slice(0, -1), extractWidgetsFromMessage(last)];
      }
      return prev;
    });

    if (t) {
      const now = Date.now();
      const totalTime = now - t.streamStartTime;
      // 真实 token 数（来自 LLM API），如果存在则覆盖估算值
      const realTokenCount = usage?.totalTokens || t.tokenCount;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.id === assistantId) {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              timing: {
                streamStartTime: t.streamStartTime,
                firstTokenTime: t.firstTokenTime,
                totalStreamTime: totalTime,
                tokenCount: realTokenCount,
                promptTokens: usage?.promptTokens,
                completionTokens: usage?.completionTokens,
                cacheReadTokens: usage?.cacheReadTokens,
                cacheWriteTokens: usage?.cacheWriteTokens,
                tokensPerSecond: totalTime > 0
                  ? Math.round((realTokenCount / totalTime) * 1000 * 10) / 10
                  : undefined,
                totalChunks: t.chunkCount,
                toolCallCount: t.toolCallCount,
              },
            },
          ];
        }
        return prev;
      });
      timingRef.current = null;
      setLiveTiming(null);
    }
    contentBuffers.get(channel)?.flush();
    contentBuffers.delete(channel);
    setIsRunning(false);
    clearCurrentChannel();
    agentService?.stopStream(channel);
  } else if (event.type === "context_rebuild") {
    contentBuffers.get(channel)?.flush();
    ctx.setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        return [...prev.slice(0, -1), addCompaction(last, event.reason, event.tokensBefore, event.tokensAfter)];
      }
      return prev;
    });
  }
}
