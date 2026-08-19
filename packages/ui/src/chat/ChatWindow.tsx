import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  AuiIf, ComposerPrimitive, ThreadPrimitive, MessagePrimitive,
  ActionBarPrimitive, ErrorPrimitive, BranchPickerPrimitive,
  SelectionToolbarPrimitive,
  useAui, useAuiState,
} from "@assistant-ui/react";
import { MiraRuntimeProvider } from "./MiraRuntimeProvider";
import { ModelSelector, loadModelChoice, loadModeChoice } from "./ModelSelector";
import type { ModelOption } from "./ModelSelector";
import type { AgentMode } from "./types";
import type { MiraMessage, MiraPart } from "./mira-runtime";
import { PermissionDialog } from "./PermissionDialog";
import { QuestionDialog } from "./QuestionDialog";
import { MarkdownText } from "../components/assistant-ui/markdown-text";
import { MessageTiming } from "../components/assistant-ui/message-timing";
import { ContextDisplay } from "../components/assistant-ui/context-display";
import { ThinkingShimmer, ReasoningBlock } from "./ThinkingBlock";
import { ProgressBar } from "./ProgressBar";
import { RenderMessageParts, findDiffSummary } from "./ToolCallView";
import { loadSettings } from "../sidebar/provider-data";
import { Copy, RotateCcw, Edit3, Square, Send, Paperclip, FileUp, ChevronLeft, ChevronRight, ListOrdered, ThumbsUp, ThumbsDown, Volume2, VolumeX, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { AnimatedAvatar, type AvatarState } from "../components/assistant-ui/animated-avatar";
import "../components/assistant-ui/animated-avatar.css";
import { VoiceInput } from "./VoiceInput";
import { VoiceChatButton } from "./VoiceChatButton";
import { GraphPanel } from "./GraphPanel";
import { ToolCallView } from "./ToolCallView";
import { MessageBubble, MessageError } from "./MessageBubble";
import { WidgetRenderer, extractWidgetBlocks } from "../components/assistant-ui/widget-renderer";
import { ErrorBoundary } from "../components/ErrorBoundary";
import type { MiraRuntimeContext } from "./MiraRuntimeProvider";
import { AgentService } from "../services/agent.service";
import { useTheme } from "../contexts/ThemeContext";
import { buildBuiltinCommands, SOURCE_LABEL, type SlashCommandDef } from "./slash-commands";
import { getTTSEngine } from "../services/voice/engine-registry";
import type { TTSEngine } from "../services/voice/types";
import { parseDroppedFiles, pickAndParseFiles, buildSendContent } from "../lib/attachment-picker-ui";
import type { PendingAttachment } from "../lib/file-parser";

interface Props { sessionId: string; onSessionChange?: (id: string) => void; onNewSession?: () => void; workspace?: string; }
interface SkillInfo { name: string; description: string; category: string | null; }

function WelcomeScreen({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-full px-4 pt-24 pb-20">
      <div className="mb-8">
        <AnimatedAvatar state="idle" size={120} />
      </div>
      <h1 className="text-2xl font-semibold mb-2" style={{ color: "var(--fg)" }}>Mira</h1>
      <p className="text-sm mb-10" style={{ color: "var(--fg-tertiary)" }}>有什么可以帮助你的？</p>
      <div className="flex flex-wrap justify-center gap-2 max-w-sm">
        {["写作", "编程", "分析数据", "搜索信息"].map((label) => (
          <button key={label} onClick={() => onSuggest(label)}
            className="px-4 py-2 text-xs rounded-full transition-all cursor-pointer"
            style={{ background: "var(--bg-secondary)", color: "var(--fg-secondary)" }}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageActions({ messageId, ctx }: { messageId: string; ctx: MiraRuntimeContext }) {
  const [speaking, setSpeaking] = useState(false);
  const ttsEngineRef = useRef<TTSEngine | null>(null);

  const messageText = useMemo(() => {
    const msg = ctx.messages.find((m) => m.id === messageId);
    return (msg?.parts || [])
      .filter((p: MiraPart) => p.type === "text" && p.text)
      .map((p: MiraPart) => (p as { text: string }).text)
      .join(" ");
  }, [ctx.messages, messageId]);

  const handleSpeak = useCallback(async () => {
    if (!ttsEngineRef.current) {
      // TTS 引擎来自目录（voice.json 默认选中），缓存复用避免重复实例化
      ttsEngineRef.current = await getTTSEngine();
    }
    const engine = ttsEngineRef.current;
    if (!engine) return;
    setSpeaking(true);
    await engine.speak(messageText, { onEnd: () => setSpeaking(false) });
    setSpeaking(false);
  }, [messageText]);

  const handleStopSpeak = useCallback(() => {
    ttsEngineRef.current?.stop();
    setSpeaking(false);
  }, []);

  return (
    <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <BranchPickerPrimitive.Root hideWhenSingleBranch className="inline-flex items-center gap-1 text-[11px]" style={{ color: "var(--fg-tertiary)" }}>
        <BranchPickerPrimitive.Previous className="flex size-6 items-center justify-center rounded-md hover:bg-muted disabled:opacity-30">
          <ChevronLeft className="w-3 h-3" />
        </BranchPickerPrimitive.Previous>
        <span className="tabular-nums"><BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count /></span>
        <BranchPickerPrimitive.Next className="flex size-6 items-center justify-center rounded-md hover:bg-muted disabled:opacity-30">
          <ChevronRight className="w-3 h-3" />
        </BranchPickerPrimitive.Next>
      </BranchPickerPrimitive.Root>
      <div className="w-px h-3 mx-1" style={{ background: "var(--border-subtle)" }} />
      <ActionBarPrimitive.Copy asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="复制"><Copy className="h-3 w-3" /></Button>
      </ActionBarPrimitive.Copy>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => ctx.retryMessage(messageId)} title="重试"><RotateCcw className="h-3 w-3" /></Button>
      <ActionBarPrimitive.Edit asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="编辑"><Edit3 className="h-3 w-3" /></Button>
      </ActionBarPrimitive.Edit>
      <ActionBarPrimitive.FeedbackPositive asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="好评"><ThumbsUp className="h-3 w-3" /></Button>
      </ActionBarPrimitive.FeedbackPositive>
      <ActionBarPrimitive.FeedbackNegative asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="差评"><ThumbsDown className="h-3 w-3" /></Button>
      </ActionBarPrimitive.FeedbackNegative>
      {speaking ? (
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleStopSpeak} title="停止朗读"><VolumeX className="h-3 w-3" /></Button>
      ) : (
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSpeak} disabled={!messageText} title="朗读"><Volume2 className="h-3 w-3" /></Button>
      )}
      <MessageTiming />
    </div>
  );
}

function ChatInner({ ctx, selectedModel, onModelChange, agentMode, onModeChange, goalCondition, setGoalCondition, onNewSession, sessionId }: {
  ctx: MiraRuntimeContext; selectedModel: ModelOption; onModelChange: (m: ModelOption) => void;
  agentMode: AgentMode; onModeChange: (m: AgentMode) => void;
  goalCondition: string | null; setGoalCondition: (v: string | null) => void;
  onNewSession?: () => void;
  sessionId: string;
}) {
  const aui = useAui();
  const composerText = useAuiState((s) => s.composer.text);
  const composerIsEmpty = useAuiState((s) => s.composer.isEmpty);
  const threadEmpty = useAuiState((s) => s.thread.isEmpty);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { setTheme } = useTheme();

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<SlashCommandDef[]>([]);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showGraphPanel, setShowGraphPanel] = useState(false);
  const [preview, setPreview] = useState<{ images: string[]; index: number } | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const dragCounter = useRef(0);
  const settings = useMemo(() => loadSettings(), []);

  // 最新助手回复文本（供语音对话自动朗读）
  const assistantText = useMemo(() => {
    const last = ctx.messages[ctx.messages.length - 1];
    if (last?.role !== "assistant") return "";
    return (last.parts || [])
      .filter((p: MiraPart) => p.type === "text" && p.text)
      .map((p: MiraPart) => (p as { text: string }).text)
      .join(" ");
  }, [ctx.messages]);

  useEffect(() => { AgentService.listSkills().then((l) => setSkills(l)).catch(() => {}); }, []);

  const builtinCommands = useMemo(
    () => buildBuiltinCommands({
      currentMode: agentMode,
      onModeChange: (m) => onModeChange(m as AgentMode),
      onNewSession,
      clearMessages: () => ctx.setMessages([]),
      sendMessage: (text) => { void ctx.sendMessage(text); },
      setGoalCondition,
      setTheme,
      openHelp: () => { void ctx.sendMessage("请列出你可以使用的斜杠命令。"); },
    }),
    [agentMode, onModeChange, onNewSession, setGoalCondition, setTheme, ctx],
  );

  // 技能命令与内置命令合并
  const allCommands = useMemo<SlashCommandDef[]>(
    () => [
      ...builtinCommands,
      ...skills.map((s) => ({
        id: `skill-${s.name}`,
        trigger: s.name,
        label: s.name,
        description: s.description,
        category: s.category || "技能",
        source: "skill" as const,
        action: () => { aui.composer().setText("/" + s.name + " "); setShowSkills(false); textareaRef.current?.focus(); },
      })),
    ],
    [builtinCommands, skills, aui],
  );

  useEffect(() => {
    const m = composerText.match(/^\/([^\s/]*)$/);
    if (m) {
      const q = m[1].toLowerCase();
      const f = allCommands.filter((c) =>
        c.trigger.toLowerCase().includes(q) || c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q),
      );
      setFilteredCommands(f);
      setShowSkills(f.length > 0);
      setSelectedCommandIndex(0);
    } else {
      setShowSkills(false);
    }
  }, [composerText, allCommands]);

  const onEnter = useCallback((e: DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounter.current++; if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) setIsDragging(true); }, []);
  const onLeave = useCallback((e: DragEvent) => { e.preventDefault(); e.stopPropagation(); dragCounter.current--; if (dragCounter.current === 0) setIsDragging(false); }, []);
  const onOver = useCallback((e: DragEvent) => { e.preventDefault(); e.stopPropagation(); }, []);
  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false); dragCounter.current = 0;
    const files = e.dataTransfer?.files; if (!files || files.length === 0) return;
    // 拖拽文件：解析所有支持类型（图片/文本/Excel/Word/PPT/PDF），加入待发送队列
    void parseDroppedFiles(Array.from(files)).then((atts) => {
      if (atts.length > 0) setPendingAttachments((prev) => [...prev, ...atts]);
    }).catch(() => { /* 解析失败不阻塞 */ });
  }, [aui]);

  useEffect(() => {
    const el = document.body; el.addEventListener("dragenter", onEnter); el.addEventListener("dragleave", onLeave);
    el.addEventListener("dragover", onOver); el.addEventListener("drop", onDrop);
    return () => { el.removeEventListener("dragenter", onEnter); el.removeEventListener("dragleave", onLeave); el.removeEventListener("dragover", onOver); el.removeEventListener("drop", onDrop); };
  }, [onEnter, onLeave, onOver, onDrop]);

  function applyCommand(cmd: SlashCommandDef) { cmd.action(); setShowSkills(false); }
  /** 发送：文本 + 待发送附件；无附件时走 composer 默认发送 */
  function handleSend() {
    if (ctx.isRunning) { ctx.stopStream(); return; }
    const text = composerText.trim();
    if (pendingAttachments.length > 0) {
      const { displayText, files, images, rejected } = buildSendContent(pendingAttachments, text);
      // 不支持的附件：UI 提示，不发送该文件
      if (rejected.length > 0) {
        const names = rejected.map((r) => r.name).join("、");
        alert(`以下文件类型暂不支持解析，已忽略：\n${names}\n（${rejected[0]?.error || ""}）`);
      }
      void ctx.sendMessage(displayText || "请查看以下内容：", images, files);
      setPendingAttachments([]);
      aui.composer().setText("");
    } else if (text) {
      aui.composer().send();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (showSkills) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelectedCommandIndex((p) => Math.min(p + 1, filteredCommands.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelectedCommandIndex((p) => Math.max(p - 1, 0)); return; }
      if (e.key === "Enter" && !e.shiftKey && filteredCommands[selectedCommandIndex]) { e.preventDefault(); applyCommand(filteredCommands[selectedCommandIndex]); return; }
      if (e.key === "Escape") { setShowSkills(false); return; }
    }
    // 有待发送附件时，Enter（非 Shift）走自定义发送
    if (e.key === "Enter" && !e.shiftKey && pendingAttachments.length > 0) {
      e.preventDefault();
      handleSend();
    }
  }

  /** 附件按钮：主进程 dialog 选择文件 */
  const handlePickImages = () => {
    void pickAndParseFiles().then((atts) => {
      if (atts.length > 0) setPendingAttachments((prev) => [...prev, ...atts]);
    }).catch((err) => {
      alert(err instanceof Error ? err.message : String(err));
    });
  };

  /** 隐藏 input 兜底（保留浏览器选择路径） */
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    void parseDroppedFiles(files).then((atts) => {
      if (atts.length > 0) setPendingAttachments((prev) => [...prev, ...atts]);
    }).catch(() => { /* 解析失败不阻塞 */ });
    e.target.value = "";
  };

  /** 粘贴文件/图片：剪贴板中的任意文件（截图图片、资源管理器复制的文件）→ 统一解析加入待发送队列 */
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) pastedFiles.push(file);
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void parseDroppedFiles(pastedFiles).then((atts) => {
        if (atts.length > 0) setPendingAttachments((prev) => [...prev, ...atts]);
      }).catch(() => { /* 解析失败不阻塞 */ });
    }
  };

  /** 发送：文本 + 待发送图片；无图片时走 composer 默认发送 */
  return (
    <div className="flex-1 flex flex-col min-h-0 relative" style={{ background: "var(--bg)" }}>
      {preview && <Lightbox images={preview.images} index={preview.index} onClose={() => setPreview(null)} onIndexChange={(i) => setPreview((p) => p ? { ...p, index: i } : p)} />}
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)" }}>
          <div className="text-center space-y-4">
            <div className="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto" style={{ border: "2px dashed rgba(255,255,255,0.3)" }}>
              <FileUp className="w-10 h-10" style={{ color: "rgba(255,255,255,0.6)" }} />
            </div>
            <p className="text-lg font-medium text-white">释放以上传文件</p>
          </div>
        </div>
      )}

      {settings.showProgressBar !== false && ctx.isRunning && <ProgressBar />}

      {showGraphPanel && (
        <div className="mx-auto w-full px-6 pt-3 max-w-[760px] xl:max-w-[900px] 2xl:max-w-[1100px]">
          <div className="rounded-xl" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
            <GraphPanel
              config={{
                sessionID: sessionId,
                model: selectedModel.value,
                provider: selectedModel.provider,
                mode: agentMode,
              }}
            />
          </div>
        </div>
      )}

      <ThreadPrimitive.Root className="flex-1 flex flex-col min-h-0">
        <ThreadPrimitive.Viewport className={`flex-1 overflow-x-hidden min-h-0 ${threadEmpty ? "overflow-y-hidden" : "overflow-y-auto scrollbar-custom"}`}>
          <div className="flex flex-col mx-auto py-6 min-h-full px-6 w-full max-w-[760px] xl:max-w-[900px] 2xl:max-w-[1100px]">
            <AuiIf condition={(s) => s.thread.isEmpty}>
              <WelcomeScreen onSuggest={(text) => { aui.composer().setText(text); textareaRef.current?.focus(); }} />
              <div className="flex flex-wrap justify-center gap-2 max-w-sm mx-auto mt-2">
                <ThreadPrimitive.Suggestions>
                  {({ suggestion }) => (
                    <ThreadPrimitive.Suggestion
                      prompt={suggestion.prompt}
                      send
                      className="px-4 py-2 text-xs rounded-full transition-all hover:bg-muted cursor-pointer"
                      style={{ background: "var(--bg-secondary)", color: "var(--fg-secondary)", border: "none" }}
                    />
                  )}
                </ThreadPrimitive.Suggestions>
              </div>
            </AuiIf>

            <ThreadPrimitive.Messages>
              {({ message }) => {
                const orig = ctx.messages.find((m: any) => m.id === message.id);
                const isUser = message.role === "user";
                const isLast = ctx.isRunning && message.id === ctx.messages[ctx.messages.length - 1]?.id;
                const avatarState: AvatarState = !isUser
                  ? isLast ? "speaking" : "idle"
                  : "idle";
                const reasoningParts = orig?.parts.filter((p: any) => p.type === "reasoning" && String(p.text || "").trim() !== "") || [];
                const showReasoning = settings.showReasoning !== false;
                const hasToolCalls = orig?.parts.some((p: any) => p.type === "tool-call");
                const diffSummaryPart = orig ? findDiffSummary(orig) : null;
                const hasCustomParts = hasToolCalls || diffSummaryPart;
                // 用户消息中的全部图片（file parts），供点击放大时左右切换
                const userImages = isUser
                  ? (orig?.parts.filter((p: any) => p.type === "file" && typeof p.url === "string" && (p.url as string).length > 0).map((p: any) => p.url as string) || [])
                  : [];
                return (
                  <ErrorBoundary
                    fallback={
                      <div className="mb-5 rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(239,68,68,0.06)", color: "var(--error)" }}>
                        该条消息渲染异常，已跳过显示
                      </div>
                    }
                  >
                    <MessagePrimitive.Root className="group mb-5 animate-message">
                    {showReasoning && reasoningParts.length > 0 && reasoningParts.map((p: any, i: number) => (
                      <ReasoningBlock key={p.reasoningId || i} text={p.text || ""} time={p.time} active={isLast} />
                    ))}
                    {isLast && !showReasoning && <ThinkingShimmer />}
                    <div className={`flex w-full gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
                      {!isUser && (
                        <div className="shrink-0 mt-1">
                          <AnimatedAvatar state={avatarState} size={28} />
                        </div>
                      )}
                      <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} max-w-[calc(100%-44px)] min-w-0`}>
                        {isUser ? (
                          <MessageBubble role="user" className="min-w-0">
                            <MessagePrimitive.Parts>
                              {({ part }) => {
                                if (part.type === "text") return <p className="whitespace-pre-wrap break-words">{part.text}</p>;
                                if (part.type === "image" && typeof (part as { image?: string }).image === "string") {
                                  const img = (part as { image: string }).image;
                                  const idx = userImages.indexOf(img);
                                  return (
                                    <img
                                      src={img}
                                      alt="图片"
                                      className="mt-2 max-w-[280px] max-h-[280px] rounded-lg object-cover cursor-zoom-in"
                                      style={{ border: "1px solid var(--border-subtle)" }}
                                      onClick={() => setPreview({ images: userImages, index: idx >= 0 ? idx : 0 })}
                                    />
                                  );
                                }
                                return null;
                              }}
                            </MessagePrimitive.Parts>
                            {/* 文件卡片（文本/Office 路径引用，非图片） */}
                            {orig?.parts.filter((p: any) => p.type === "file" && !p.url && p.name).map((p: any, i: number) => (
                              <div key={`fc-${i}`} className="mt-2 flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs"
                                style={{ background: "var(--surface-secondary)", border: "1px solid var(--border-light)" }}>
                                <span className="text-base leading-none">📎</span>
                                <span className="font-medium truncate max-w-[200px]" style={{ color: "var(--text-primary)" }}>{p.name}</span>
                                <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px]"
                                  style={{ background: "var(--bg-secondary)", color: "var(--text-tertiary)" }}>
                                  {p.kind === "excel" ? "Excel" : p.kind === "word" ? "Word" : p.kind === "ppt" ? "PPT" : "文件"}
                                </span>
                              </div>
                            ))}
                          </MessageBubble>
                        ) : (
                          <MessageBubble role="assistant" className="min-w-0">
                            <MessagePrimitive.Parts>
                              {({ part }) => { if (part.type === "text") return <MarkdownText />; return null; }}
                            </MessagePrimitive.Parts>
                            {orig && orig.parts.some((p: any) => p.type === "widget") && (
                              <div className="mt-2 space-y-3">
                                {orig.parts.filter((p: any) => p.type === "widget").map((p: any, i: number) => (
                                  <WidgetRenderer key={i} html={p.html || ""} />
                                ))}
                              </div>
                            )}
                            {hasCustomParts && orig && (
                              <div className="mt-2 space-y-1.5">
                                <RenderMessageParts message={orig} />
                              </div>
                            )}
                            <SelectionToolbarPrimitive.Root>
                              <SelectionToolbarPrimitive.Quote
                                className="inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium text-muted-foreground hover:bg-muted transition-colors"
                              />
                            </SelectionToolbarPrimitive.Root>
                          </MessageBubble>
                        )}
                        <MessagePrimitive.Error>
                          <ErrorPrimitive.Root className="mt-2 rounded-md px-3 py-2 text-xs" style={{ background: "rgba(239,68,68,0.08)", color: "var(--error)" }}>
                            <ErrorPrimitive.Message />
                          </ErrorPrimitive.Root>
                        </MessagePrimitive.Error>
                        {!isUser && <MessageError text={orig?.error} />}
                        {!isUser && <MessageActions messageId={message.id} ctx={ctx} />}
                      </div>
                    </div>
                  </MessagePrimitive.Root>
                  </ErrorBoundary>
                );
              }}
            </ThreadPrimitive.Messages>
            {!threadEmpty && (
              <div className="flex flex-wrap justify-center gap-2 max-w-sm mx-auto mt-1">
                <ThreadPrimitive.Suggestions>
                  {({ suggestion }) => (
                    <ThreadPrimitive.Suggestion
                      prompt={suggestion.prompt}
                      send
                      className="px-4 py-2 text-xs rounded-full transition-all hover:bg-muted cursor-pointer"
                      style={{ background: "var(--bg-secondary)", color: "var(--fg-secondary)", border: "none" }}
                    />
                  )}
                </ThreadPrimitive.Suggestions>
              </div>
            )}
            <div className="h-4" />
          </div>

          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-10" style={{ background: "linear-gradient(to top, var(--bg) 60%, transparent)" }}>
            <div className="mx-auto px-6 pb-4 pt-2" style={{ maxWidth: "900px" }}>
              {showSkills && (
                <div className="mb-3 rounded-xl overflow-hidden" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", boxShadow: "var(--shadow-elevated)" }}>
                  <div className="px-3 py-1.5 text-[10px] font-medium" style={{ color: "var(--fg-tertiary)", borderBottom: "1px solid var(--border-subtle)" }}>命令 — 回车执行 / ↑↓ 选择</div>
                  <div className="max-h-48 overflow-y-auto scrollbar-custom">
                    {Object.entries(
                      filteredCommands.reduce<Record<string, SlashCommandDef[]>>((acc, c) => {
                        (acc[c.category] ||= []).push(c)
                        return acc
                      }, {}),
                    ).map(([category, cmds]) => (
                      <div key={category}>
                        <div className="px-3 py-1 text-[10px] font-medium" style={{ color: "var(--fg-tertiary)" }}>{category}</div>
                        {cmds.map((cmd, idx) => {
                          const globalIdx = filteredCommands.indexOf(cmd)
                          return (
                            <button key={cmd.id} onMouseDown={() => applyCommand(cmd)}
                              className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${globalIdx === selectedCommandIndex ? "bg-primary/10" : ""}`}
                              style={{ color: globalIdx === selectedCommandIndex ? "var(--primary)" : "var(--fg-secondary)" }}>
                              <span className="font-mono font-medium" style={{ color: "var(--primary)" }}>/</span>
                              <span className="font-medium">{cmd.trigger}</span>
                              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--bg-secondary)", color: "var(--fg-tertiary)" }}>
                                {SOURCE_LABEL[cmd.source]}
                              </span>
                              {cmd.description && (
                                <span className="text-[10px] truncate ml-auto max-w-[45%]" style={{ color: "var(--fg-tertiary)" }}>{cmd.description}</span>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 rounded-xl px-4 py-3 transition-all duration-200"
                  style={{ background: "var(--bg-elevated)", border: "1px solid", borderColor: isFocused ? "var(--fg)" : "var(--border)", boxShadow: isFocused ? "var(--shadow-elevated)" : "none" }}>
                  {/* 待发送附件预览（图片缩略图 / 文件卡片，可移除 / 图片点击放大） */}
                  {pendingAttachments.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {pendingAttachments.map((att, i) => {
                        const imageUrl = att.kind === "image" ? att.data : undefined;
                        const fileLabel = att.kind === "image" ? "图片"
                          : att.kind === "pdf" ? "PDF"
                          : att.kind === "excel" ? "Excel"
                          : att.kind === "word" ? "Word"
                          : att.kind === "ppt" ? "PPT"
                          : att.kind === "text" ? "文本"
                          : "文件";
                        return (
                          <div key={i} className="relative group flex items-center gap-2 px-2 py-1.5 rounded-lg"
                            style={{ background: "var(--surface-secondary)", border: "1px solid var(--border-light)" }}>
                            {imageUrl ? (
                              <img src={imageUrl} alt={att.name}
                                className="h-10 w-10 object-cover rounded-md cursor-zoom-in"
                                onClick={() => setPreview({ images: pendingAttachments.filter(a => a.kind === "image").map(a => a.data), index: pendingAttachments.filter(a => a.kind === "image").map(a => a.data).indexOf(imageUrl) >= 0 ? pendingAttachments.filter(a => a.kind === "image").map(a => a.data).indexOf(imageUrl) : 0 })} />
                            ) : (
                              <div className="flex items-center justify-center h-10 w-10 rounded-md text-xs font-medium"
                                style={{ background: "var(--bg-secondary)", color: "var(--primary)" }}>
                                {fileLabel.slice(0, 2)}
                              </div>
                            )}
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs truncate max-w-[120px]" style={{ color: "var(--text-primary)" }}>{att.name}</span>
                              <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                                {att.kind === "image" ? "图片" : `${(att.size / 1024).toFixed(1)} KB`}{att.error ? ` · 解析失败` : ""}
                              </span>
                            </div>
                            <button
                              className="shrink-0 p-0.5 rounded hover:bg-muted cursor-pointer"
                              style={{ color: "var(--text-tertiary)" }}
                              onClick={() => setPendingAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                              title="移除">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <ComposerPrimitive.Quote className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs"
                    style={{ background: "var(--surface-secondary)", border: "1px solid var(--border-light)" }}>
                    <ComposerPrimitive.QuoteText className="flex-1 truncate" />
                    <ComposerPrimitive.QuoteDismiss className="shrink-0 p-0.5 rounded hover:bg-muted cursor-pointer"
                      style={{ color: "var(--text-tertiary)" }}>
                      ✕
                    </ComposerPrimitive.QuoteDismiss>
                  </ComposerPrimitive.Quote>
                  <div className="flex items-center gap-2">
                  <input ref={fileInputRef} type="file" multiple hidden onChange={handleFileInput} />
                  <Button variant="ghost" size="icon" className="h-7 w-7" title="添加附件" onClick={handlePickImages}>
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <ComposerPrimitive.Dictate asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="语音输入">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                        <line x1="12" y1="19" x2="12" y2="22"/>
                      </svg>
                    </Button>
                  </ComposerPrimitive.Dictate>
                  <VoiceChatButton onSendMessage={(t) => void ctx.sendMessage(t)} assistantText={assistantText} />
                  <ComposerPrimitive.DictationTranscript className="text-xs px-2 py-1 rounded" style={{ background: "var(--bg-secondary)", color: "var(--fg-secondary)" }} />
                  <ComposerPrimitive.Queue>
                    {() => (
                      <button className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono"
                        style={{ background: "color-mix(in srgb, var(--info) 10%, transparent)", color: "var(--primary)" }}>
                        <ListOrdered className="w-3 h-3" />
                        <span>排队中</span>
                      </button>
                    )}
                  </ComposerPrimitive.Queue>
                  <ComposerPrimitive.Input ref={textareaRef} onKeyDown={handleKeyDown} onPaste={handlePaste}
                    onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)}
                    placeholder="输入消息..." rows={1}
                    className="input-field min-h-[24px] max-h-[200px]" />
                  {/* 合并发送/停止：运行中显示停止方块，空闲显示发送 */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleSend}
                    title={ctx.isRunning ? "停止" : "发送"}
                    className="h-7 w-7 shrink-0"
                    style={{
                      color: ctx.isRunning ? "var(--error)" : (composerIsEmpty && pendingAttachments.length === 0 ? "var(--fg-tertiary)" : "var(--fg)"),
                      background: ctx.isRunning ? "rgba(239,68,68,0.08)" : "transparent",
                    }}
                  >
                    {ctx.isRunning ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <Send className="h-4 w-4" />}
                  </Button>
                </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => setShowGraphPanel((v) => !v)}
                      title="编码任务图"
                      className="h-7 text-[11px] gap-1.5"
                      style={{ color: showGraphPanel ? "var(--primary)" : undefined }}
                    >
                      <ListOrdered className="h-3.5 w-3.5" />
                      {showGraphPanel ? "收起图" : "编码图"}
                    </Button>
                    <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} agentMode={agentMode} onModeChange={onModeChange} />
                  </div>
                  <div className="flex items-center gap-2">
                    {ctx.isRunning && ctx.liveTiming && (
                      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono"
                        style={{ background: "color-mix(in srgb, var(--info) 8%, transparent)", color: "var(--primary)" }}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                        <span>{ctx.liveTiming.tokenCount} tok</span>
                        {ctx.liveTiming.firstTokenTime && (
                          <span>
                            {((ctx.liveTiming.tokenCount / (Date.now() - ctx.liveTiming.streamStartTime)) * 1000).toFixed(1)} t/s
                          </span>
                        )}
                      </div>
                    )}
                    <ContextDisplay />
                  </div>
                </div>

                {goalCondition && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs" style={{ background: "rgba(255,184,0,0.06)", border: "1px solid rgba(255,184,0,0.12)" }}>
                    <span className="font-medium" style={{ color: "var(--warning)" }}>Goal</span>
                    <span className="flex-1 truncate" style={{ color: "var(--fg)" }}>{goalCondition}</span>
                    <Button variant="ghost" onClick={() => setGoalCondition(null)} className="h-[22px] px-2 text-[11px]" >清除</Button>
                  </div>
                )}
              </div>
            </div>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>

      {ctx.questionReq && <QuestionDialog question={ctx.questionReq.question} options={ctx.questionReq.options} onSubmit={ctx.handleQuestionAnswer} />}
      {ctx.permissionReq && (
        <PermissionDialog toolName={ctx.permissionReq.tool_name} args={ctx.permissionReq.args} reason={ctx.permissionReq.reason}
          onAllow={() => ctx.handlePermission(true)} onDeny={() => ctx.handlePermission(false)}
          onAlways={ctx.permissionReq.channel ? () => ctx.handlePermission("always") : undefined} />
      )}
    </div>
  );
}

function ChatContent({ sessionId, onSessionChange, onNewSession, workspace }: { sessionId: string; onSessionChange?: (id: string) => void; onNewSession?: () => void; workspace?: string }) {
  const [selectedModel, setSelectedModel] = useState<ModelOption>(loadModelChoice);
  const [agentMode, setAgentMode] = useState<AgentMode>(loadModeChoice);
  const [goalCondition, setGoalCondition] = useState<string | null>(null);

  // 切换会话时重置模型/模式/Goal（替代原先 key={sessionId} 的 remount 语义，
  // 保持会话切换不中断后台流）
  useEffect(() => {
    setSelectedModel(loadModelChoice());
    setAgentMode(loadModeChoice());
    setGoalCondition(null);
  }, [sessionId]);

  useEffect(() => {
    const modes: AgentMode[] = ["assistant", "expert", "action", "safe", "plan"];
    const h = (e: KeyboardEvent) => {
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ta = document.querySelector("textarea");
        if (!document.activeElement?.isSameNode(ta) || !ta?.value) {
          e.preventDefault();
          const i = modes.indexOf(agentMode);
          setAgentMode(modes[(i + 1) % modes.length]);
          localStorage.setItem("chat_mode", modes[(i + 1) % modes.length]);
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [agentMode]);

  return (
    <MiraRuntimeProvider sessionId={sessionId} selectedModel={selectedModel} agentMode={agentMode} goalCondition={goalCondition} onSessionChange={onSessionChange} workspace={workspace}>
      {(ctx) => (
        <ChatInner ctx={ctx} selectedModel={selectedModel} onModelChange={setSelectedModel}
          agentMode={agentMode} onModeChange={setAgentMode}
          goalCondition={goalCondition} setGoalCondition={setGoalCondition} onNewSession={onNewSession}
          sessionId={sessionId} />
      )}
    </MiraRuntimeProvider>
  );
}

export function ChatWindow({ sessionId, onSessionChange, onNewSession, workspace }: Props) {
  // 注意：不再用 key={sessionId} 强制重建组件树，
  // 会话状态由 session-runtime-store 管理，切换只换视图、不中断后台流
  return <ChatContent sessionId={sessionId} onSessionChange={onSessionChange} onNewSession={onNewSession} workspace={workspace} />;
}

/** 全屏图片预览（多图左右切换，点击图片/遮罩/Esc/关闭按钮退出） */
function Lightbox({ images, index, onClose, onIndexChange }: {
  images: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const total = images.length;
  const prev = () => onIndexChange((index - 1 + total) % total);
  const next = () => onIndexChange((index + 1) % total);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, index, total]);

  const src = images[index] || images[0];

  return (
    <div
      className="fixed inset-0 z-[999] flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <img
        src={src}
        alt="预览"
        className="max-h-full max-w-full object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {total > 1 && (
        <>
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            title="上一张"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center justify-center w-10 h-10 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
            onClick={(e) => { e.stopPropagation(); next(); }}
            title="下一张"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs text-white/80"
            style={{ background: "rgba(255,255,255,0.1)" }}>
            {index + 1} / {total}
          </div>
        </>
      )}
      <button
        className="absolute top-4 right-4 flex items-center justify-center w-9 h-9 rounded-full text-white/80 hover:text-white hover:bg-white/10 transition-colors"
        onClick={onClose}
        title="关闭"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
}
