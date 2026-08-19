import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useExternalStoreRuntime,
  AssistantRuntimeProvider,
  createMessageQueue,
  WebSpeechSynthesisAdapter,
  WebSpeechDictationAdapter,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";
import { useMiraChat } from "../hooks/useMiraChat";
import { convertMessage, type MiraMessage } from "./mira-runtime";
import type { ModelOption } from "./ModelSelector";
import type { AgentMode } from "./types";
import type { PendingFileRef } from "../lib/attachment-picker-ui";
import { fileAttachmentAdapter } from "../lib/attachment-adapter";
import { generateFollowUpSuggestions } from "./follow-up-suggestions";
import { loadSettings as getSettings } from "../sidebar/provider-data";

export interface MiraRuntimeContext {
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
  handlePermission: (approved: boolean | "always") => Promise<void>;
  handleQuestionAnswer: (answer: string) => void;
  handleToolResult: (toolName: string, result: any) => void;
  stopStream: () => void;
  sendMessage: (content: string, images?: string[], files?: PendingFileRef[]) => Promise<void>;
  retryMessage: (assistantMsgId: string) => Promise<void>;
  setMessages: React.Dispatch<React.SetStateAction<MiraMessage[]>>;
}

interface Props {
  sessionId: string;
  selectedModel: ModelOption;
  agentMode: AgentMode;
  goalCondition?: string | null;
  onSessionChange?: (sessionId: string) => void;
  workspace?: string;
  children: ReactNode | ((ctx: MiraRuntimeContext) => ReactNode);
}

export function MiraRuntimeProvider({
  sessionId,
  selectedModel,
  agentMode,
  goalCondition,
  onSessionChange,
  workspace,
  children,
}: Props) {
  const chat = useMiraChat({
    sessionId,
    selectedModel,
    agentMode,
    goalCondition,
    onSessionChange,
    workspace,
  });

  /** LLM 生成的追问建议（回复完成后异步获取；null = 未生成/失败，回退启发式） */
  const [llmFollowUps, setLlmFollowUps] = useState<string[] | null>(null);

  useEffect(() => {
    const last = chat.messages[chat.messages.length - 1];
    setLlmFollowUps(null);
    if (last?.role !== "assistant" || chat.isRunning || !sessionId) return;
    // 设置开关：关闭时跳过 LLM 生成，回退启发式
    if (getSettings().followUpLlm === false) return;
    let cancelled = false;
    window.electronAPI.agent.suggestFollowUps(sessionId)
      .then((r) => {
        if (!cancelled && r?.suggestions?.length) setLlmFollowUps(r.suggestions);
      })
      .catch(() => { /* LLM 生成失败时保持启发式降级 */ });
    return () => { cancelled = true; };
  }, [chat.messages.length, chat.isRunning, sessionId]);

  /** 用 ref 保存最新回调，避免 queue/回调闭包捕获旧会话的 sendMessage（多会话并发关键） */
  const sendMessageRef = useRef(chat.sendMessage);
  const setMessagesRef = useRef(chat.setMessages);
  const messagesRef = useRef(chat.messages);
  useEffect(() => {
    sendMessageRef.current = chat.sendMessage;
    setMessagesRef.current = chat.setMessages;
    messagesRef.current = chat.messages;
  }, [chat.sendMessage, chat.setMessages, chat.messages]);

  /** 从消息附件中提取图片 data URL（仅接受 image 类型的附件） */
  const extractImages = useCallback((parts: readonly { type: string; image?: string }[]): string[] => {
    return parts
      .filter((p): p is { type: string; image: string } => p.type === "image" && typeof p.image === "string" && p.image.length > 0)
      .map((p) => p.image);
  }, []);

  /** 发送队列 — 运行时允许排队发消息 */
  const [queue] = useState(() =>
    createMessageQueue({
      async run(message: AppendMessage) {
        const images = extractImages(message.content);
        // 纯图片消息：无文本也允许发送（图片附空提示）
        const firstText = (message.content.find((p) => p.type === "text") as { text?: string } | undefined)?.text || "";
        if (message.content[0]?.type !== "text" && images.length === 0) return;
        let input = firstText;
        const quote = (message.metadata as { custom?: { quote?: { text: string; messageId: string } } })?.custom?.quote;
        if (quote?.text) {
          input = `[引用: "${quote.text}"]\n\n${input}`;
        }
        const imageText = images.length > 0 ? `\n\n[图片 ${images.length} 张]` : "";
        if (imageText) {
          input = `${input}${imageText}`;
        }
        await sendMessageRef.current(input || "请查看图片：", images);
      },
    }),
  )

  // 同步运行状态到队列
  const prevRunning = useRef(chat.isRunning)
  useEffect(() => {
    if (!prevRunning.current && chat.isRunning) {
      queue.notifyBusy()
    } else if (prevRunning.current && !chat.isRunning) {
      queue.notifyIdle()
    }
    prevRunning.current = chat.isRunning
  }, [chat.isRunning, queue])

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const images = extractImages(message.content);
      // 纯图片消息：无文本也允许发送
      const firstText = (message.content.find((p) => p.type === "text") as { text?: string } | undefined)?.text || "";
      if (message.content[0]?.type !== "text" && images.length === 0) return;
      let input = firstText;
      const quote = (message.metadata as { custom?: { quote?: { text: string; messageId: string } } })?.custom?.quote;
      if (quote?.text) {
        input = `[引用: "${quote.text}"]\n\n${input}`;
      }
      const imageText = images.length > 0 ? `\n\n[图片 ${images.length} 张]` : "";
      if (imageText) {
        input = `${input}${imageText}`;
      }
      await sendMessageRef.current(input || "请查看图片：", images);
    },
    [extractImages]
  );

  const onCancel = useCallback(() => {
    chat.stopStream();
    return Promise.resolve();
  }, [chat.stopStream]);

  /** 编辑消息后重新发送 */
  const onEdit = useCallback(
    async (message: AppendMessage) => {
      if (message.content[0]?.type !== "text") return;
      // 找到被编辑的消息位置，截断其后所有消息
      const input = message.content[0].text;
      const parentId = message.parentId;
      if (parentId) {
        setMessagesRef.current((prev) => {
          const idx = prev.findIndex(m => m.id === parentId);
          if (idx >= 0) return prev.slice(0, idx + 1);
          return prev;
        });
      }
      await sendMessageRef.current(input);
    },
    []
  );

  /** 重新生成最后一条助手回复 */
  const onReload = useCallback(
    async (parentId: string | null) => {
      if (!parentId) return;
      // 找到 user 消息，重发
      setMessagesRef.current((prev) => {
        const idx = prev.findIndex(m => m.id === parentId);
        if (idx >= 0) {
          const userMsg = prev[idx];
          const userText = userMsg.parts.find(p => p.type === "text")?.text;
          if (userText) {
            // 删除 user 和之后的 assistant 消息
            return prev.slice(0, idx);
          }
        }
        return prev;
      });
      // 从原始消息重发
      const userMsg = messagesRef.current.find(m => m.id === parentId);
      if (userMsg) {
        const text = userMsg.parts.find(p => p.type === "text")?.text;
        if (text) await sendMessageRef.current(text);
      }
    },
    []
  );

  const convertedMessages = useMemo(() => {
    return chat.messages.map((msg) => convertMessage(msg));
  }, [chat.messages]);

  const roles = new Set(["user", "assistant"]);

  const convertThreadMessage = useCallback(
    (message: ThreadMessageLike, idx: number): ThreadMessageLike => {
      const role = roles.has(message.role) ? message.role : "assistant";
      return {
        role,
        content: Array.isArray(message.content) ? message.content : [{ type: "text" as const, text: (message.content || "") as string }],
        id: message.id,
        createdAt: message.createdAt,
      };
    },
    []
  );

  const suggestions = useMemo(() => {
    if (chat.messages.length === 0) {
      return [
        { prompt: "帮我写一段代码" },
        { prompt: "分析这份数据" },
        { prompt: "搜索一下最新AI新闻" },
        { prompt: "解释这个技术概念" },
      ];
    }
    // 回复后追问建议：优先 LLM 生成，未生成/失败时降级为内容启发式
    const last = chat.messages[chat.messages.length - 1];
    if (last?.role !== "assistant") return undefined;
    if (llmFollowUps && llmFollowUps.length > 0) {
      return llmFollowUps.map((prompt) => ({ prompt }));
    }
    const text = (last.parts || [])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => (p as { text: string }).text)
      .join(" ");
    return generateFollowUpSuggestions(text).map((prompt) => ({ prompt }));
  }, [chat.messages.length, llmFollowUps]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    isRunning: chat.isRunning,
    messages: convertedMessages,
    onNew,
    onCancel,
    onEdit,
    onReload,
    setMessages: chat.setMessages as any,
    convertMessage: convertThreadMessage,
    suggestions,
    queue: queue.adapter,
    adapters: {
      attachments: fileAttachmentAdapter,
      speech: new WebSpeechSynthesisAdapter(),
      dictation: new WebSpeechDictationAdapter(),
      feedback: {
        submit: (feedback) => {
          try {
            const store = JSON.parse(localStorage.getItem("mira-feedback") || "{}") as Record<string, string>;
            store[feedback.message.id] = feedback.type;
            localStorage.setItem("mira-feedback", JSON.stringify(store));
          } catch { /* 忽略持久化失败 */ }
        },
      },
    },
  });

  const context: MiraRuntimeContext = {
    messages: chat.messages,
    isRunning: chat.isRunning,
    liveTiming: chat.liveTiming,
    permissionReq: chat.permissionReq,
    questionReq: chat.questionReq,
    handlePermission: chat.handlePermission,
    handleQuestionAnswer: chat.handleQuestionAnswer,
    handleToolResult: chat.handleToolResult,
    stopStream: chat.stopStream,
    sendMessage: chat.sendMessage,
    retryMessage: chat.retryMessage,
    setMessages: chat.setMessages,
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {typeof children === "function" ? children(context) : children}
    </AssistantRuntimeProvider>
  );
}
