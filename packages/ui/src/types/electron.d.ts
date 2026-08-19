/**
 * Electron API 类型声明
 *
 * 此文件保留全局 Window 类型声明。
 * 具体业务类型请从 services/ 目录导入。
 */

export interface ElectronAPI {
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  /** 首帧渲染就绪上报（取消主进程 boot 超时提示） */
  notifyRendererReady: () => void;
  getPathForFile: (file: File) => string;
  openFile: () => Promise<{ token: string; files: Array<{ path: string; name: string; size: number }>; error?: string }>;
  openDirectory: () => Promise<string[]>;
  saveFile: (name: string) => Promise<string>;
  readPickedFile: (token: string, filePath: string) => Promise<ArrayBuffer>;
  releasePickedFiles: (token: string) => Promise<void>;
  notify: (title: string, body: string) => Promise<void>;
  encryptApiKey: (text: string) => Promise<string>;
  decryptApiKey: (encrypted: string) => Promise<string>;
  isEncryptionAvailable: () => Promise<boolean>;
  platform: string;

  // 配置系统（JSON 文件 + 环境变量）
  config: {
    get: (workspace?: string) => Promise<{ provider: string; model: string; apiUrl: string; mode: string; apiKeyFrom: "env" | "file" | "none"; apiKey?: string; headers?: Record<string, string>; options?: Record<string, unknown> }>;
    save: (config: Record<string, unknown>) => Promise<void>;
    getProviderCatalog: () => Promise<Array<{
      id: string; label: string; website?: string; defaultBaseUrl: string; authType: string
      models: Array<{ id: string; label?: string; context?: number; capabilities?: string[] }>
    }>>;
    // 语音引擎目录与默认选中项（一切皆插件）
    getVoiceCatalog: () => Promise<{
      catalog: Array<{ id: string; kind: "stt" | "tts" | "vad"; label: string; implementation: string; model?: string; params?: Record<string, unknown> }>;
      defaults: Partial<Record<"stt" | "tts" | "vad" | "dictation", string>>;
    }>;
    saveVoiceConfig: (defaults: Record<string, string | undefined>) => Promise<void>;
  };

  // TS Core 会话/项目管理
  ts: {
    listProjects: () => Promise<Array<{ project_id: string; name: string; workspace_path: string }>>;
    createProject: (name: string, workspace: string) => Promise<{ project_id: string }>;
    updateProject: (projectId: string, data: { name?: string; workspace_path?: string }) => Promise<void>;
    deleteProject: (projectId: string) => Promise<void>;
    createSession: (projectId: string, title?: string) => Promise<{ session_id: string; title: string; kind: string; workspace_path: string; message_count: number; updated_at: string }>;
    listSessions: (projectId?: string) => Promise<Array<{ session_id: string; title: string; kind: string; workspace_path: string; message_count: number; updated_at: string; cost?: number; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>>;
    getSessionMessages: (sessionId: string) => Promise<Array<{ id: number; role: string; content: string }>>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteSessions: (sessionIds: string[]) => Promise<void>;
    deleteMessage: (sessionId: string, messageId: number) => Promise<void>;
    updateSession: (sessionId: string, data: { title?: string }) => Promise<void>;
    searchMessages: (query: string) => Promise<Array<{ session_id: string; session_title: string; message: { role: string; content: string; timestamp: string }; context: string }>>;
    restoreSnapshot: (snapshotId: string, workspace: string) => Promise<string[]>;
    writeFile: (filePath: string, content: string) => Promise<boolean>;
    readAttachment: (relPath: string) => Promise<string>;
    getDefaultWorkspace: () => Promise<string>;
  };

  // TypeScript Agent Core
  agent: {
    executeTool: (name: string, args: Record<string, unknown>) => Promise<{ success: boolean; output?: string; error?: string }>;
    listTools: (mode?: string) => Promise<Array<{ name: string; description: string; parameters: Record<string, unknown> }>>;
    /** 列出可用 Skill */
    listSkills: () => Promise<Array<{ name: string; description: string; category: string | null }>>;

    /** Question — Agent 向用户提问 */
    question: {
      answer: (questionId: string, answer: string) => Promise<boolean>;
      listPending: () => Promise<Array<{ id: string; question: string; options?: string[] }>>;
    };

    /** Task Tracker */
    task: {
      create: (summary: string, parentId?: string) => Promise<{ id: string; summary: string; status: string }>;
      updateStatus: (taskId: string, status: string) => Promise<boolean>;
      updateSummary: (taskId: string, summary: string) => Promise<boolean>;
      addNote: (taskId: string, note: string) => Promise<boolean>;
      get: (taskId: string) => Promise<{ id: string; summary: string; status: string; children: any[] } | null>;
      list: (status?: string) => Promise<Array<{ id: string; summary: string; status: string }>>;
      listActive: () => Promise<Array<{ id: string; summary: string; status: string }>>;
      toText: () => Promise<string>;
    };

    /** Subagent Manager */
    subagent: {
      spawn: (description: string, options?: { parentId?: string; prompt?: string }) => Promise<{ id: string; description: string; status: string }>;
      wait: (id: string, timeoutMs?: number) => Promise<{ id: string; status: string; result: string | null; error: string | null }>;
      cancel: (id: string) => Promise<boolean>;
      get: (id: string) => Promise<{ id: string; description: string; status: string; result: string | null } | null>;
      list: (filter?: { parentId?: string; status?: string }) => Promise<Array<{ id: string; description: string; status: string }>>;
      listActive: () => Promise<Array<{ id: string; description: string; status: string }>>;
      cancelAll: () => Promise<boolean>;
      toText: () => Promise<string>;
    };

    /** Goal Manager */
    goal: {
      set: (description: string, timeoutMs?: number) => Promise<{ id: string; description: string; status: string }>;
      getActive: () => Promise<{ id: string; description: string; status: string } | null>;
      list: () => Promise<Array<{ id: string; description: string; status: string }>>;
      cancel: () => Promise<boolean>;
      toText: () => Promise<string>;
    };

    /** Dream/Distill Manager */
    dreamDistill: {
      dream: (conversationHistory: any[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) =>
        Promise<{ timestamp: string; knowledgeExtracted: string[]; outdatedRemoved: string[]; summary: string }>;
      distill: (conversationHistory: any[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) =>
        Promise<{ timestamp: string; workflowsFound: any[]; summary: string }>;
      getKnowledge: () => Promise<Array<{ id: string; content: string; tags: string[] }>>;
      toText: () => Promise<string>;
    };

    /** Compose Mode */
    compose: {
      start: (spec: string) => Promise<{ phase: string; spec: string; startedAt: string }>;
      getState: () => Promise<{ phase: string; spec: string; plan: string | null; codeFiles: string[] } | null>;
      getCurrentSkill: () => Promise<{ name: string; description: string; phase: string; tools: string[] } | null>;
      advance: () => Promise<string | null>;
      goTo: (phase: string) => Promise<boolean>;
      update: (updates: any) => Promise<boolean>;
      addCodeFile: (filePath: string) => Promise<boolean>;
      addReviewComment: (comment: string) => Promise<boolean>;
      addTestResult: (result: string) => Promise<boolean>;
      addDebugLog: (log: string) => Promise<boolean>;
      setVerificationPassed: (passed: boolean) => Promise<boolean>;
      complete: () => Promise<{ phase: string; spec: string } | null>;
      cancel: () => Promise<{ phase: string; spec: string } | null>;
      getHistory: () => Promise<Array<{ phase: string; spec: string }>>;
      toText: () => Promise<string>;
      getSkills: () => Promise<Array<{ name: string; description: string; phase: string; tools: string[] }>>;
      getPhaseOrder: () => Promise<string[]>;
    };

    /** 实时流式 Agent（支持交互式权限确认） */
    startStream: (sessionId: string, message: string, config: Record<string, unknown>) => Promise<string>;
    /** 回复权限请求 */
    replyPermission: (channel: string, requestId: string, reply: "allow" | "deny" | "always") => Promise<void>;
    /** 停止 Agent 流 */
    stopStream: (channel: string) => Promise<void>;
    /** 用 LLM 生成会话追问建议 */
    suggestFollowUps: (sessionId: string) => Promise<{ suggestions: string[] }>;
    /** 监听 Agent 事件 */
    onEvent: (channel: string, callback: (event: any) => void) => () => void;
  };

  memory: {
    search: (query: string, type?: string, limit?: number) => Promise<Array<{ id: string; content: string; tags: string[] }>>;
    searchByProject: (query: string, projectId: string, limit?: number) => Promise<Array<{ content: string; source: string; sessionId: string }>>;
    getGraphData: () => Promise<{ entities: Array<{ id: string; name: string; type: string; description?: string }>; relationships: Array<{ source: string; target: string; relation: string }> }>;
    status: () => Promise<{ ready: boolean; count: number }>;
  };

  /** 运行期自修改（动态插件状态 + client half UI） */
  selfmod: {
    status: () => Promise<{ enabled: boolean }>;
    listPlugins: (sessionId: string) => Promise<{ plugins: Array<{ pluginId: string; name: string; status?: string }>; enabled: boolean }>;
    getClientCode: (body: { sessionId: string; pluginId: string; packageId?: string }) => Promise<{ ok: boolean; clientCode?: string; error?: string }>;
  };

  /** Live2D 桌宠 */
  live2d: {
    toggle: (enabled: boolean) => Promise<void>;
  };

  /** 桌面悬浮球 */
  floatingBall: {
    toggle: (enabled: boolean) => Promise<{ success: boolean }>;
    wake: () => void;
    hide: () => void;
    updateConfig: (config: Record<string, unknown>) => Promise<unknown>;
    onStateChange: (callback: (state: { state: string; reason: string }) => void) => () => void;
  };

  /** 监听 Core sidecar 连接状态（断连/重连中/恢复），供前端显示遮罩并自动刷新 */
  onSidecarStatus: (callback: (status: "connected" | "reconnecting") => void) => () => void;

  /** Graph 图编排 */
  graph: {
    runCodingTask: (
      request: string,
      config: Record<string, unknown>,
      options?: { maxSteps?: number; testCommand?: string; maxTotalTokens?: number },
    ) => Promise<{ runId: string }>;
    getStatus: (runId: string) => Promise<{ runId: string; active: boolean }>;
    listRuns: (graphId?: string) => Promise<Array<{
      graphId: string;
      runId: string;
      completedNodes: string[];
      state: Record<string, unknown>;
      visited: string[];
      totalTokens: number;
      updatedAt: string;
    }>>;
    stop: (runId: string) => Promise<boolean>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
