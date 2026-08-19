import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { MiraMessage } from "../chat/mira-runtime";
import type { ModelOption } from "../chat/ModelSelector";
import type { AgentMode } from "../chat/types";
import type { ToolResult } from "../services/agent.service";
import type { PendingFileRef } from "../lib/attachment-picker-ui";
import {
  ensureSession,
  getSessionState,
  subscribe,
  getVersion,
  loadHistoryForSession,
  sendMessageToSession,
  stopSession,
  setSessionMessages,
  appendToolResultMessage,
  replyPermissionForSession,
  answerQuestionForSession,
} from "./session-runtime-store";

interface UseMiraChatOptions {
  sessionId: string;
  selectedModel: ModelOption;
  agentMode: AgentMode;
  goalCondition?: string | null;
  onSessionChange?: (sessionId: string) => void;
  workspace?: string;
}

interface UseMiraChatReturn {
  messages: MiraMessage[];
  isRunning: boolean;
  liveTiming: {
    streamStartTime: number;
    firstTokenTime?: number;
    tokenCount: number;
    chunkCount: number;
    toolCallCount: number;
  } | null;
  permissionReq: {
    tool_name: string;
    args: Record<string, unknown>;
    reason: string;
    request_id: string;
    channel?: string;
  } | null;
  questionReq: {
    question: string;
    options: string[];
    request_id: string;
  } | null;
  sendMessage: (content: string, images?: string[], files?: PendingFileRef[]) => Promise<void>;
  retryMessage: (assistantMsgId: string) => Promise<void>;
  stopStream: () => void;
  handlePermission: (approved: boolean | "always") => Promise<void>;
  handleQuestionAnswer: (answer: string) => void;
  handleToolResult: (toolName: string, result: ToolResult) => void;
  loadHistory: () => Promise<void>;
  setMessages: React.Dispatch<React.SetStateAction<MiraMessage[]>>;
}

const EMPTY_STATE = {
  messages: [],
  isRunning: false,
  liveTiming: null,
  permissionReq: null,
  questionReq: null,
  channel: null,
  streamCleanup: null,
  dbLoaded: false,
  pendingQueue: [],
  timingRef: null,
  loadingTimeout: null,
  lastSendOpts: null,
  lastActivity: 0,
};

export function useMiraChat({
  sessionId,
  selectedModel,
  agentMode,
  goalCondition,
  onSessionChange,
  workspace,
}: UseMiraChatOptions): UseMiraChatReturn {
  // 订阅 store 变化（多会话并发：store 更新触发本组件 re-render）
  useSyncExternalStore(subscribe, getVersion);

  useEffect(() => {
    if (!sessionId) return;
    ensureSession(sessionId);
    void loadHistoryForSession(sessionId);
  }, [sessionId]);

  const state = sessionId ? getSessionState(sessionId) : EMPTY_STATE;

  const sendMessage = useCallback(
    (content: string, images?: string[], files?: PendingFileRef[]) =>
      sendMessageToSession(sessionId, content, {
        selectedModel,
        agentMode,
        goalCondition,
        workspace,
        onSessionChange,
      }, images, files),
    [sessionId, selectedModel, agentMode, goalCondition, workspace, onSessionChange]
  );

  const retryMessage = useCallback(
    async (assistantMsgId: string) => {
      if (!sessionId) return;
      let userContent = "";
      let userDbId: number | undefined;
      let assistantDbId: number | undefined;
      setSessionMessages(sessionId, (prev) => {
        const idx = prev.findIndex(m => m.id === assistantMsgId);
        if (idx > 0 && prev[idx - 1]?.role === "user") {
          const userPart = prev[idx - 1].parts.find(p => p.type === "text");
          userContent = userPart?.text || "";
          userDbId = prev[idx - 1].dbId;
          assistantDbId = prev[idx].dbId;
          return prev.filter((_, i) => i !== idx - 1 && i !== idx);
        }
        return prev;
      });
      // 清理 DB 中旧的 user/assistant 消息，避免重试后重复累积
      if (userContent) {
        if (userDbId !== undefined) {
          window.electronAPI.ts.deleteMessage(sessionId, userDbId).catch(() => {});
        }
        if (assistantDbId !== undefined) {
          window.electronAPI.ts.deleteMessage(sessionId, assistantDbId).catch(() => {});
        }
        await sendMessage(userContent);
      }
    },
    [sendMessage, sessionId]
  );

  const stopStream = useCallback(() => {
    if (sessionId) stopSession(sessionId);
  }, [sessionId]);

  const handlePermission = useCallback(
    async (approved: boolean | "always") => {
      if (sessionId) await replyPermissionForSession(sessionId, approved);
    },
    [sessionId]
  );

  const handleQuestionAnswer = useCallback(
    (answer: string) => {
      if (sessionId) void answerQuestionForSession(sessionId, answer);
    },
    [sessionId]
  );

  const handleToolResult = useCallback(
    (toolName: string, result: ToolResult) => {
      if (sessionId) appendToolResultMessage(sessionId, toolName, result);
    },
    [sessionId]
  );

  const loadHistory = useCallback(async () => {
    if (sessionId) await loadHistoryForSession(sessionId);
  }, [sessionId]);

  const setMessages = useCallback(
    (updater: React.SetStateAction<MiraMessage[]>) => {
      if (sessionId) setSessionMessages(sessionId, typeof updater === "function" ? updater : () => updater);
    },
    [sessionId]
  );

  return {
    messages: state.messages,
    isRunning: state.isRunning,
    liveTiming: state.liveTiming,
    permissionReq: state.permissionReq,
    questionReq: state.questionReq,
    sendMessage,
    retryMessage,
    stopStream,
    handlePermission,
    handleQuestionAnswer,
    handleToolResult,
    loadHistory,
    setMessages,
  };
}
