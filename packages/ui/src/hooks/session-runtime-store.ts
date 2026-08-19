/**
 * 会话运行时全局 Store — 多会话并发 + 切换不中断
 *
 * 所有会话的运行时状态（消息/运行状态/权限请求/SSE 监听）集中在此，
 * 与组件生命周期解耦：
 * - 切换会话只改视图（activeSessionId），后台会话的 SSE 监听持续接收并写入 store
 * - 关闭窗口（隐藏到托盘）期间渲染进程存活，后台会话继续积累
 * - 同一会话正在运行时再发消息 → 进入待发队列，回合结束后自动发送
 * - 运行中会话不被 LRU 逐出；非运行会话保留最近 20 个，超出释放
 */

import {
  createMiraMessage,
  type MiraMessage,
  type MiraPart,
} from "../chat/mira-runtime"
import { handleStreamEvent, clearChannelBuffer, type StreamEventContext } from "./stream-events"
import { getProviderById, loadSettings as getSettings } from "../sidebar/provider-data"
import { decideVisionPolicy } from "../sidebar/provider-model"
import type { ModelOption } from "../chat/ModelSelector"
import type { AgentMode } from "../chat/types"
import type { PendingFileRef } from "../lib/attachment-picker-ui"
import type { AgentEvent, ToolResult } from "../services/agent.service"
import type { AgentService as AgentServiceShape } from "../services/agent.service"

interface LiveTiming {
  streamStartTime: number;
  firstTokenTime?: number;
  tokenCount: number;
  chunkCount: number;
  toolCallCount: number;
}

interface PermissionReq {
  tool_name: string;
  args: Record<string, unknown>;
  reason: string;
  request_id: string;
  channel?: string;
}

interface QuestionReq {
  question: string;
  options: string[];
  request_id: string;
}

export interface SessionState {
  messages: MiraMessage[];
  isRunning: boolean;
  liveTiming: LiveTiming | null;
  permissionReq: PermissionReq | null;
  questionReq: QuestionReq | null;
  channel: string | null;
  streamCleanup: (() => void) | null;
  dbLoaded: boolean;
  pendingQueue: string[];
  timingRef: LiveTiming | null;
  loadingTimeout: ReturnType<typeof setTimeout> | null;
  lastSendOpts: SendOptions | null;
  lastSendImages: string[] | null;
  lastSendFiles: PendingFileRef[] | null;
  lastActivity: number;
}

export interface SendOptions {
  selectedModel: ModelOption;
  agentMode: AgentMode;
  goalCondition?: string | null;
  workspace?: string;
  onSessionChange?: (id: string) => void;
}

// ── 存储与订阅 ───────────────────────────────────────

const sessions = new Map<string, SessionState>();
const listeners = new Set<() => void>();
let activeSessionId = "";
let version = 0;

function emit(): void {
  version++;
  listeners.forEach((l) => l());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getVersion(): number {
  return version;
}

export function getActiveSessionId(): string {
  return activeSessionId;
}

export function setActiveSessionId(id: string): void {
  activeSessionId = id;
  emit();
}

export function ensureSession(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
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
      lastSendImages: null,
      lastSendFiles: null,
      lastActivity: Date.now(),
    };
    sessions.set(sessionId, s);
  }
  s.lastActivity = Date.now();
  evictIfNeeded();
  return s;
}

export function getSessionState(sessionId: string): SessionState {
  return ensureSession(sessionId);
}

export function getSessions(): ReadonlyMap<string, SessionState> {
  return sessions;
}

export function isSessionRunning(sessionId: string): boolean {
  return sessions.get(sessionId)?.isRunning || false;
}

// ── 消息更新 ─────────────────────────────────────────

export function setSessionMessages(
  sessionId: string,
  updater: MiraMessage[] | ((prev: MiraMessage[]) => MiraMessage[]),
): void {
  const s = ensureSession(sessionId);
  s.messages = typeof updater === "function" ? updater(s.messages) : updater;
  s.lastActivity = Date.now();
  emit();
}

function setSessionPermissionReq(sessionId: string, v: PermissionReq | null): void {
  const s = ensureSession(sessionId);
  s.permissionReq = v;
  emit();
  notifyIfBackground(sessionId);
}

function setSessionQuestionReq(sessionId: string, v: QuestionReq | null): void {
  const s = ensureSession(sessionId);
  s.questionReq = v;
  emit();
  notifyIfBackground(sessionId);
}

// ── LRU 逐出（运行中的会话永不逐出） ────────────────

const MAX_KEPT = 20;

function evictIfNeeded(): void {
  if (sessions.size <= MAX_KEPT) return;
  const candidates = [...sessions.entries()]
    .filter(([id, s]) => id !== activeSessionId && !s.isRunning && !s.channel)
    .sort((a, b) => a[1].lastActivity - b[1].lastActivity);
  let overflow = sessions.size - MAX_KEPT;
  for (const [id, s] of candidates) {
    if (overflow <= 0) break;
    try { s.streamCleanup?.(); } catch { /* ignore */ }
    if (s.loadingTimeout) clearTimeout(s.loadingTimeout);
    sessions.delete(id);
    overflow--;
  }
  if (overflow > 0) emit();
}

// ── 后台请求通知 ─────────────────────────────────────

function notifyIfBackground(sessionId: string): void {
  if (sessionId === activeSessionId) return;
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    if (s.permissionReq) {
      window.electronAPI.notify("Mira 需要权限", `会话「${sessionId.slice(-8)}」请求权限：${s.permissionReq.tool_name}。请切回处理。`);
    } else if (s.questionReq) {
      window.electronAPI.notify("Mira 向你提问", `会话「${sessionId.slice(-8)}」有待回答问题。请切回处理。`);
    }
  } catch { /* 通知失败静默 */ }
}

// ── AgentService 注入 ───────────────────────────────

let agentService: typeof AgentServiceShape | null = null;

export async function getAgentService(): Promise<typeof AgentServiceShape | null> {
  if (!agentService) {
    const mod = await import("../services/agent.service");
    agentService = mod.AgentService;
    const { setAgentService } = await import("./stream-events");
    setAgentService(mod.AgentService);
  }
  return agentService;
}

// ── 历史加载 ─────────────────────────────────────────

export async function loadHistoryForSession(sessionId: string): Promise<void> {
  const s = ensureSession(sessionId);
  if (s.dbLoaded) return;
  // 正在运行或已有实时消息时不覆盖（保留最新增量）
  if (s.messages.length > 0 || s.channel) {
    s.dbLoaded = true;
    emit();
    return;
  }
  try {
    const { SessionService } = await import("../services/session.service");
    const tsMsgs = await SessionService.getMessages(sessionId);
    if (tsMsgs && tsMsgs.length > 0) {
      const mapped = await Promise.all(
        tsMsgs
          .filter((msg) => msg.role !== "tool")
          .map(async (msg) => ({
            id: `msg-${msg.id}`,
            dbId: msg.id,
            role: msg.role as "user" | "assistant",
            parts: await parseStoredMessageContent(msg.content),
            createdAt: msg.timestamp ? new Date(msg.timestamp) : undefined,
            retryCount: msg.retryCount || 0,
          })),
      );
      s.messages = mapped;
    } else {
      s.messages = [];
    }
  } catch {
    s.messages = [];
  } finally {
    s.dbLoaded = true;
    emit();
  }
}

async function parseStoredMessageContent(content: string): Promise<MiraMessage["parts"]> {
  if (!content) return [];
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const parts: MiraMessage["parts"] = [];
        if (typeof parsed.text === "string" && parsed.text) {
          parts.push({ type: "text", text: parsed.text });
        }
        // 会话附件恢复：读回图片（异步）
        if (Array.isArray(parsed.images)) {
          for (const relPath of parsed.images) {
            if (typeof relPath !== "string") continue;
            try {
              const dataUrl = await window.electronAPI.ts.readAttachment(relPath);
              if (dataUrl) {
                parts.push({
                  type: "file",
                  url: dataUrl,
                  name: relPath.split("/").pop() || "图片",
                  mime: dataUrl.split(";")[0].replace("data:", ""),
                });
              }
            } catch { /* 附件读取失败跳过 */ }
          }
        }
        if (Array.isArray(parsed.tool_calls)) {
          for (const tc of parsed.tool_calls) {
            if (tc && typeof tc.id === "string" && typeof tc.name === "string") {
              parts.push({
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.name,
                args: (tc.args as Record<string, unknown>) || {},
                status: "done",
                result: "",
              });
            }
          }
        }
        if (parts.length > 0) return parts;
      }
    } catch { /* 非 JSON 按纯文本 */ }
  }
  return [{ type: "text", text: content }];
}

// ── 发送 / 停止 / 释放 ───────────────────────────────

/** 中止发送：以错误消息回显 assistant 消息，复位运行状态（用于图片校验失败 / 识图不可用） */
function abortSendWithMessage(sessionId: string, assistantId: string, message: string): void {
  const s = ensureSession(sessionId);
  setSessionMessages(sessionId, (prev) => {
    const idx = prev.findIndex((m) => m.id === assistantId);
    if (idx >= 0) {
      const next = [...prev];
      next[idx] = createMiraMessage("assistant", message, assistantId);
      return next;
    }
    return [...prev, createMiraMessage("assistant", message, assistantId)];
  });
  if (s.loadingTimeout) { clearTimeout(s.loadingTimeout); s.loadingTimeout = null; }
  s.isRunning = false;
  s.lastSendOpts = null;
  s.lastSendImages = null;
  s.lastSendFiles = null;
  emit();
}

export async function sendMessageToSession(
  initialSessionId: string,
  content: string,
  opts: SendOptions,
  images?: string[],
  files?: PendingFileRef[],
): Promise<void> {
  if (!content) return;
  const svc = await getAgentService();
  if (!svc) return;

  let sessionId = initialSessionId;

  // 无会话时创建会话（迁移自 useMiraChat 原有逻辑）
  if (!sessionId) {
    try {
      const projects = await window.electronAPI.ts.listProjects();
      const projectId = projects?.[0]?.project_id;
      if (projectId) {
        const session = await window.electronAPI.ts.createSession(projectId, content.slice(0, 50));
        if (session?.session_id) {
          sessionId = session.session_id;
          opts.onSessionChange?.(sessionId);
        }
      }
    } catch { /* 静默 */ }
  }
  if (!sessionId) return;

  const s = ensureSession(sessionId);

  // 正在运行 → 排队，回合结束后自动发送
  if (s.isRunning || s.channel) {
    if (!s.pendingQueue.includes(content)) {
      s.pendingQueue.push(content);
      s.lastSendOpts = opts;
      s.lastSendImages = images || null;
      s.lastSendFiles = files || null;
      s.lastActivity = Date.now();
      emit();
    }
    return;
  }

  const effectiveContent = opts.goalCondition
    ? `[Goal: ${opts.goalCondition}]\n\n${content}`
    : content;

  // user 消息 parts：文本 + 图片（缩略图）+ 文件卡片（路径引用）
  const userParts: MiraPart[] = [{ type: "text", text: effectiveContent }];
  if (images && images.length > 0) {
    for (const img of images) {
      userParts.push({
        type: "file",
        url: img,
        name: "图片",
        mime: img.split(";")[0].replace("data:", ""),
      });
    }
  }
  if (files && files.length > 0) {
    for (const f of files) {
      userParts.push({
        type: "file",
        url: "",
        name: f.name,
        kind: f.kind,
        path: f.path,
      });
    }
  }

  const userMsg = createMiraMessage("user", userParts);
  const assistantId = crypto.randomUUID();
  const assistantMsg = createMiraMessage("assistant", [], assistantId);

  s.messages = [...s.messages, userMsg, assistantMsg];
  s.isRunning = true;
  s.lastSendOpts = opts;
  s.lastSendImages = images || null;
  s.lastSendFiles = files || null;
  s.lastActivity = Date.now();
  emit();

  if (s.loadingTimeout) clearTimeout(s.loadingTimeout);
  s.loadingTimeout = setTimeout(() => {
    const cur = sessions.get(sessionId);
    if (cur) { cur.isRunning = false; emit(); }
  }, 120000);

  try {
    const provider = await getProviderById(opts.selectedModel.provider);
    const apiKey = provider?.apiKey || "";
    const apiUrl = provider?.apiUrl || "";
    const settings = getSettings();

    if (apiKey) {
      // 识图策略决策（② 层唯一决策入口）：
      // - vision/multimodal → direct：图片直发主模型
      // - text/voice/未知 → bridge：自动推导视觉桥模型描述；无可用桥 → blocked
      const settings2 = getSettings();
      const policy = await decideVisionPolicy(
        opts.selectedModel.provider,
        opts.selectedModel.value,
        opts.selectedModel.type,
        settings2.visionModelOverride
          ? { provider: settings2.visionModelOverride.provider, model: settings2.visionModelOverride.model }
          : undefined,
      );

      // 图片安全校验 + 识图能力校验：不满足则中止发送并提示
      if (images && images.length > 0) {
        const { validateImages } = await import("../sidebar/provider-model");
        const validation = validateImages(images);
        if (!validation.ok) {
          // [附件校验诊断] 打印被拒图片的 data URL 前缀（定位 MIME / base64 字符集问题）
          console.warn(
            `[附件校验] 拒绝 ${images.length} 张图片: ${validation.reason}; ` +
              `示例前缀: ${String(images[0]).slice(0, 120)}`,
          );
          abortSendWithMessage(sessionId, assistantId, validation.reason || "图片无效");
          return;
        }
        if (policy.strategy === "blocked") {
          abortSendWithMessage(sessionId, assistantId, policy.reason);
          return;
        }
      }

      const config = {
        sessionID: sessionId,
        workspace: opts.workspace || "",
        model: opts.selectedModel.value,
        apiKey,
        apiUrl,
        provider: opts.selectedModel.provider,
        mode: opts.agentMode,
        headers: provider?.headers || {},
        maxMode: settings.maxMode || false,
        maxModeCandidates: 3,
        autoAcceptPermissions: settings.autoAcceptPermissions || false,
        options: { ...(provider?.options || {}), shell: settings.terminalShell || "default" },
        // 模型是否支持直接识图（vision/multimodal 直发，其余 false）
        modelVision: policy.strategy === "direct",
        // 非视觉模型自动推导的视觉桥模型
        ...(policy.strategy === "bridge" ? { visionModel: policy.visionModel } : {}),
        // 用户上传的图片（data URL 数组，随会话传给 core 注入 ImagePart）
        ...(images && images.length > 0 ? { images } : {}),
        // 文本/Office 文件的路径引用（core 端读取/解析注入）
        ...(files && files.length > 0 ? { files } : {}),
      };

      const channel = await svc.startStream(sessionId, effectiveContent, config);
      const cur = ensureSession(sessionId);
      cur.channel = channel;
      cur.timingRef = { streamStartTime: Date.now(), tokenCount: 0, chunkCount: 0, toolCallCount: 0 };
      cur.liveTiming = { ...cur.timingRef };
      cur.lastActivity = Date.now();
      emit();

      const sessionCtx = makeCtx(sessionId, assistantId);
      const cleanup = svc.onEvent(channel, (event: AgentEvent) => {
        handleStreamEvent(event, channel, assistantId, sessionCtx);
        if (event.type === "finish" || event.type === "error") {
          const cur = ensureSession(sessionId);
          if (cur.streamCleanup === cleanup) cur.streamCleanup = null;
          cur.channel = null;
          emit();
          cleanup();
          if (event.type === "finish") {
            setTimeout(() => drainPending(sessionId), 0);
          }
        }
      });
      const cur2 = ensureSession(sessionId);
      cur2.streamCleanup = cleanup;
      emit();
      return;
    }

    // 无 API Key → 关键词路由（本地工具）
    const tools = await svc.listTools().catch(() => []);
    if (tools.length > 0) {
      const { routeToolMessage } = await import("../chat/tool-router");
      const toolRoute = routeToolMessage(content, tools);
      if (toolRoute) {
        const result = await svc.executeTool(toolRoute.name, toolRoute.args);
        setSessionMessages(sessionId, (prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, parts: [{ type: "text", text: result.success ? `✅ **${toolRoute.name}** 执行成功\n\n${result.output}` : `❌ **${toolRoute.name}** 执行失败\n\n${result.error || "未知错误"}` }] }
              : m,
          ),
        );
        const cur = ensureSession(sessionId);
        cur.isRunning = false;
        emit();
        return;
      }
    }

    setSessionMessages(sessionId, (prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? { ...m, parts: [{ type: "text", text: "⚠️ 未配置 API Key。请点击右上角 ⚙️ 设置，配置 Provider 的 API Key 后启用 AI 对话，或使用 🔧 工具面板执行本地工具。" }] }
          : m,
      ),
    );
    const cur = ensureSession(sessionId);
    cur.isRunning = false;
    emit();
  } catch (err: any) {
    console.error("Chat error:", err);
    setSessionMessages(sessionId, (prev) =>
      prev.map((m) =>
        m.id === assistantId
          ? { ...m, parts: [{ type: "text", text: `⚠️ 发送失败：${err?.message || String(err)}` }] }
          : m,
      ),
    );
    const cur = ensureSession(sessionId);
    cur.isRunning = false;
    cur.channel = null;
    emit();
  }
}

/** 构造绑定到指定会话的事件上下文（setter 均指向该会话） */
function makeCtx(sessionId: string, assistantId: string): StreamEventContext {
  return {
    setMessages: (updater) => setSessionMessages(sessionId, updater),
    setIsRunning: (v) => {
      const s = ensureSession(sessionId);
      s.isRunning = typeof v === "function" ? v(s.isRunning) : v;
      s.lastActivity = Date.now();
      emit();
    },
    clearCurrentChannel: () => {
      const s = ensureSession(sessionId);
      s.channel = null;
      emit();
    },
    sessionId,
    setPermissionReq: (updater) => {
      const s = ensureSession(sessionId);
      const next = typeof updater === "function" ? updater(s.permissionReq) : updater;
      setSessionPermissionReq(sessionId, next);
    },
    setQuestionReq: (updater) => {
      const s = ensureSession(sessionId);
      const next = typeof updater === "function" ? updater(s.questionReq) : updater;
      setSessionQuestionReq(sessionId, next);
    },
    setLiveTiming: (updater) => {
      const s = ensureSession(sessionId);
      s.liveTiming = typeof updater === "function" ? updater(s.liveTiming) : updater;
      emit();
    },
    timingRef: {
      get current() { return ensureSession(sessionId).timingRef; },
      set current(v) { ensureSession(sessionId).timingRef = v; },
    },
  };
}

/** 回合结束后自动发送排队消息 */
function drainPending(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s || s.isRunning || s.pendingQueue.length === 0) return;
  const content = s.pendingQueue.shift()!;
  const opts = s.lastSendOpts;
  const images = s.lastSendImages || undefined;
  const files = s.lastSendFiles || undefined;
  s.lastActivity = Date.now();
  emit();
  if (opts) void sendMessageToSession(sessionId, content, opts, images, files);
}

export function stopSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { s.streamCleanup?.(); } catch { /* ignore */ }
  s.streamCleanup = null;
  if (s.channel) clearChannelBuffer(s.channel);
  if (s.loadingTimeout) { clearTimeout(s.loadingTimeout); s.loadingTimeout = null; }
  const ch = s.channel;
  s.channel = null;
  s.isRunning = false;
  s.liveTiming = null;
  s.timingRef = null;
  s.pendingQueue = [];
  emit();
  if (ch) {
    void getAgentService().then((svc) => svc?.stopStream(ch)).catch(() => {});
  }
}

export function disposeSession(sessionId: string): void {
  stopSession(sessionId);
  sessions.delete(sessionId);
  emit();
}

// ── 手动工具结果 / 权限 / 提问 ───────────────────────

export function appendToolResultMessage(sessionId: string, toolName: string, result: ToolResult): void {
  const header = `**${toolName}**`;
  const content = result.success
    ? `${header}\n\n${result.output}`
    : `${header}\n\n${result.error || "执行失败"}`;
  const msg = createMiraMessage("assistant", content);
  setSessionMessages(sessionId, (prev) => [...prev, msg]);
}

export async function replyPermissionForSession(
  sessionId: string,
  approved: boolean | "always",
): Promise<void> {
  const s = ensureSession(sessionId);
  const req = s.permissionReq;
  if (!req) return;
  setSessionPermissionReq(sessionId, null);
  if (req.channel) {
    const svc = await getAgentService();
    await svc?.replyPermission(req.channel, req.request_id, approved === "always" ? "always" : approved ? "allow" : "deny");
  }
}

export async function answerQuestionForSession(sessionId: string, answer: string): Promise<void> {
  const s = ensureSession(sessionId);
  const req = s.questionReq;
  if (!req) return;
  setSessionQuestionReq(sessionId, null);
  const svc = await getAgentService();
  try {
    await svc?.answerQuestion(req.request_id, answer);
  } catch (err) {
    console.error("Failed to answer question:", err);
  }
}
