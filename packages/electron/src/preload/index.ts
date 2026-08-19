import type { IpcRendererEvent } from "electron";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const electronAPI = {
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  maximizeWindow: () => ipcRenderer.send("window:maximize"),
  closeWindow: () => ipcRenderer.send("window:close"),

  /** 首帧渲染就绪上报（取消主进程 boot 超时提示） */
  notifyRendererReady: () => ipcRenderer.send("mira:renderer-boot"),

  /** 拖拽/粘贴 File 的原始路径（官方 API，替代已弃用的 File.path） */
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  openFile: () => ipcRenderer.invoke("dialog:openFile"),
  openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  saveFile: (name: string) => ipcRenderer.invoke("dialog:saveFile", name),
  readPickedFile: (token: string, filePath: string) => ipcRenderer.invoke("dialog:readFile", token, filePath),
  releasePickedFiles: (token: string) => ipcRenderer.invoke("dialog:releaseFiles", token),

  notify: (title: string, body: string) => ipcRenderer.invoke("notify", title, body),

  encryptApiKey: (text: string) => ipcRenderer.invoke("safeStorage:encrypt", text),
  decryptApiKey: (encrypted: string) => ipcRenderer.invoke("safeStorage:decrypt", encrypted),
  isEncryptionAvailable: () => ipcRenderer.invoke("safeStorage:isAvailable"),

  platform: process.platform,

  // 配置系统（JSON 文件 + 环境变量）
  config: {
    get: (workspace?: string) => ipcRenderer.invoke("config:get", workspace),
    save: (config: Record<string, unknown>) => ipcRenderer.invoke("config:save", config),
    getProviderCatalog: () => ipcRenderer.invoke("config:getProviderCatalog"),
    // 语音引擎目录与默认选中项（一切皆插件）
    getVoiceCatalog: () => ipcRenderer.invoke("config:getVoiceCatalog"),
    saveVoiceConfig: (defaults: Record<string, string | undefined>) =>
      ipcRenderer.invoke("config:saveVoiceConfig", defaults),
  },

  // TS Core 会话/项目
  ts: {
    listProjects: () => ipcRenderer.invoke("ts:listProjects"),
    createProject: (name: string, workspace: string) => ipcRenderer.invoke("ts:createProject", name, workspace),
    updateProject: (projectId: string, data: { name?: string; workspace_path?: string }) => ipcRenderer.invoke("ts:updateProject", projectId, data),
    deleteProject: (projectId: string) => ipcRenderer.invoke("ts:deleteProject", projectId),
    createSession: (projectId: string, title?: string) => ipcRenderer.invoke("ts:createSession", projectId, title),
    listSessions: (projectId?: string) => ipcRenderer.invoke("ts:listSessions", projectId),
    getSessionMessages: (sessionId: string) => ipcRenderer.invoke("ts:getSessionMessages", sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke("ts:deleteSession", sessionId),
    deleteSessions: (sessionIds: string[]) => ipcRenderer.invoke("ts:deleteSessions", sessionIds),
    deleteMessage: (sessionId: string, messageId: number) => ipcRenderer.invoke("ts:deleteMessage", sessionId, messageId),
    updateSession: (sessionId: string, data: { title?: string }) => ipcRenderer.invoke("ts:updateSession", sessionId, data),
    searchMessages: (query: string) => ipcRenderer.invoke("ts:searchMessages", query),
    restoreSnapshot: (snapshotId: string, workspace: string) => ipcRenderer.invoke("ts:restoreSnapshot", snapshotId, workspace),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke("ts:writeFile", filePath, content),
    readAttachment: (relPath: string) => ipcRenderer.invoke("ts:readAttachment", relPath),
    getDefaultWorkspace: () => ipcRenderer.invoke("ts:getDefaultWorkspace"),
  },

  // TypeScript Agent Core IPC
  agent: {
    executeTool: (name: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke("agent:executeTool", name, args),
    listTools: () => ipcRenderer.invoke("agent:listTools"),
    listAgents: () => ipcRenderer.invoke("agent:listAgents"),
    /** 实时流式 Agent（支持交互式权限确认） */
    startStream: (sessionId: string, message: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke("agent:startStream", sessionId, message, config),

    /** 回复权限请求 */
    replyPermission: (channel: string, requestId: string, reply: "allow" | "deny" | "always") =>
      ipcRenderer.invoke("agent:replyPermission", channel, requestId, reply),

    /** 停止 Agent 流 */
    stopStream: (channel: string) => ipcRenderer.invoke("agent:stopStream", channel),

    /** 用 LLM 生成会话追问建议 */
    suggestFollowUps: (sessionId: string) => ipcRenderer.invoke("agent:suggestFollowUps", sessionId),

    /** 列出可用 Skill */
    listSkills: () => ipcRenderer.invoke("skill:listSkills"),

    /** Question — Agent 向用户提问 */
    question: {
      answer: (questionId: string, answer: string) => ipcRenderer.invoke("question:answer", questionId, answer),
      listPending: () => ipcRenderer.invoke("question:listPending"),
    },

    /** Task Tracker */
    task: {
      create: (summary: string, parentId?: string) => ipcRenderer.invoke("task:create", summary, parentId),
      updateStatus: (taskId: string, status: string) => ipcRenderer.invoke("task:updateStatus", taskId, status),
      updateSummary: (taskId: string, summary: string) => ipcRenderer.invoke("task:updateSummary", taskId, summary),
      addNote: (taskId: string, note: string) => ipcRenderer.invoke("task:addNote", taskId, note),
      get: (taskId: string) => ipcRenderer.invoke("task:get", taskId),
      list: (status?: string) => ipcRenderer.invoke("task:list", status),
      listActive: () => ipcRenderer.invoke("task:listActive"),
      toText: () => ipcRenderer.invoke("task:toText"),
    },

    /** Subagent Manager */
    subagent: {
      spawn: (description: string, options?: { parentId?: string; prompt?: string }) =>
        ipcRenderer.invoke("subagent:spawn", description, options),
      wait: (id: string, timeoutMs?: number) => ipcRenderer.invoke("subagent:wait", id, timeoutMs),
      cancel: (id: string) => ipcRenderer.invoke("subagent:cancel", id),
      get: (id: string) => ipcRenderer.invoke("subagent:get", id),
      list: (filter?: { parentId?: string; status?: string }) => ipcRenderer.invoke("subagent:list", filter),
      listActive: () => ipcRenderer.invoke("subagent:listActive"),
      cancelAll: () => ipcRenderer.invoke("subagent:cancelAll"),
      toText: () => ipcRenderer.invoke("subagent:toText"),
    },

    /** Goal Manager */
    goal: {
      set: (description: string, timeoutMs?: number) => ipcRenderer.invoke("goal:set", description, timeoutMs),
      getActive: () => ipcRenderer.invoke("goal:getActive"),
      list: () => ipcRenderer.invoke("goal:list"),
      cancel: () => ipcRenderer.invoke("goal:cancel"),
      toText: () => ipcRenderer.invoke("goal:toText"),
      load: (sessionID: string) => ipcRenderer.invoke("goal:load", sessionID),
      save: () => ipcRenderer.invoke("goal:save"),
    },

    /** Dream/Distill Manager */
    dreamDistill: {
      dream: (conversationHistory: any[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) =>
        ipcRenderer.invoke("dreamDistill:dream", conversationHistory, config),
      distill: (conversationHistory: any[], config: { apiKey: string; apiUrl: string; model: string; provider: string }) =>
        ipcRenderer.invoke("dreamDistill:distill", conversationHistory, config),
      getKnowledge: () => ipcRenderer.invoke("dreamDistill:getKnowledge"),
      toText: () => ipcRenderer.invoke("dreamDistill:toText"),
    },

    /** Compose Mode */
    compose: {
      start: (spec: string) => ipcRenderer.invoke("compose:start", spec),
      getState: () => ipcRenderer.invoke("compose:getState"),
      getCurrentSkill: () => ipcRenderer.invoke("compose:getCurrentSkill"),
      advance: () => ipcRenderer.invoke("compose:advance"),
      goTo: (phase: string) => ipcRenderer.invoke("compose:goTo", phase),
      update: (updates: any) => ipcRenderer.invoke("compose:update", updates),
      addCodeFile: (filePath: string) => ipcRenderer.invoke("compose:addCodeFile", filePath),
      addReviewComment: (comment: string) => ipcRenderer.invoke("compose:addReviewComment", comment),
      addTestResult: (result: string) => ipcRenderer.invoke("compose:addTestResult", result),
      addDebugLog: (log: string) => ipcRenderer.invoke("compose:addDebugLog", log),
      setVerificationPassed: (passed: boolean) => ipcRenderer.invoke("compose:setVerificationPassed", passed),
      complete: () => ipcRenderer.invoke("compose:complete"),
      cancel: () => ipcRenderer.invoke("compose:cancel"),
      getHistory: () => ipcRenderer.invoke("compose:getHistory"),
      toText: () => ipcRenderer.invoke("compose:toText"),
      getSkills: () => ipcRenderer.invoke("compose:getSkills"),
      getPhaseOrder: () => ipcRenderer.invoke("compose:getPhaseOrder"),
    },

    /** 监听 Agent 事件 */
    onEvent: (channel: string, callback: (event: any) => void) => {
      const handler = (_event: IpcRendererEvent, evtChannel: string, ...args: any[]) => {
        if (evtChannel === channel) callback(args[0])
      }
      ipcRenderer.on("agent:event", handler)
      return () => ipcRenderer.removeListener("agent:event", handler)
    },
  },

  /** Graph 图编排 */
  graph: {
    runCodingTask: (request: string, config: Record<string, unknown>, options?: { maxSteps?: number; testCommand?: string; maxTotalTokens?: number }) =>
      ipcRenderer.invoke("graph:runCodingTask", request, config, options),
    getStatus: (runId: string) => ipcRenderer.invoke("graph:getStatus", runId),
    listRuns: (graphId?: string) => ipcRenderer.invoke("graph:listRuns", graphId),
    stop: (runId: string) => ipcRenderer.invoke("graph:stop", runId),
  },

  /** 记忆系统 */
  memory: {
    search: (query: string, type?: string, limit?: number) =>
      ipcRenderer.invoke("memory:search", query, type, limit),
    searchByProject: (query: string, projectId: string, limit?: number) =>
      ipcRenderer.invoke("memory:searchByProject", query, projectId, limit),
    getGraphData: () => ipcRenderer.invoke("memory:getGraphData"),
    status: () => ipcRenderer.invoke("memory:status"),
  },

  /** 运行期自修改（动态插件状态 + client half UI） */
  selfmod: {
    status: () => ipcRenderer.invoke("selfmod:status"),
    listPlugins: (sessionId: string) => ipcRenderer.invoke("selfmod:listPlugins", sessionId),
    getClientCode: (body: { sessionId: string; pluginId: string; packageId?: string }) =>
      ipcRenderer.invoke("selfmod:getClientCode", body),
  },

  live2d: {
    toggle: (enabled: boolean) => ipcRenderer.invoke("live2d:toggle", enabled),
  },

  // 桌面悬浮球
  floatingBall: {
    toggle: (enabled: boolean) => ipcRenderer.invoke("floatingBall:toggle", enabled),
    wake: () => ipcRenderer.send("floatingBall:wake"),
    hide: () => ipcRenderer.send("floatingBall:hide"),
    updateConfig: (config: Record<string, unknown>) => ipcRenderer.invoke("floatingBall:updateConfig", config),
    onStateChange: (callback: (state: { state: string; reason: string }) => void) => {
      const handler = (_event: IpcRendererEvent, state: { state: string; reason: string }) => callback(state)
      ipcRenderer.on("floatingBall:stateChange", handler)
      return () => ipcRenderer.removeListener("floatingBall:stateChange", handler)
    },
    // 悬浮球 UI 直接调用的方法
    dragStart: (point: { x: number; y: number }) => ipcRenderer.send("floating-ball:drag-start", point),
    dragMove: (point: { x: number; y: number }) => ipcRenderer.send("floating-ball:drag-move", point),
    dragEnd: () => ipcRenderer.send("floating-ball:drag-end"),
    click: () => ipcRenderer.send("floating-ball:click"),
    closePanel: () => ipcRenderer.send("floating-ball:close-panel"),
    sendMessage: (text: string) => ipcRenderer.send("floating-ball:send-message", text),
    onMessage: (callback: (data: { role: string; content: string }) => void) => {
      const handler = (_event: IpcRendererEvent, data: { role: string; content: string }) => callback(data)
      ipcRenderer.on("floating-ball:message", handler)
      return () => ipcRenderer.removeListener("floating-ball:message", handler)
    },
  },

  /** 监听 Core sidecar 连接状态（断连/重连中/恢复），供前端显示遮罩并自动刷新 */
  onSidecarStatus: (callback: (status: "connected" | "reconnecting") => void) => {
    const handler = (_event: IpcRendererEvent, status: "connected" | "reconnecting") => callback(status)
    ipcRenderer.on("sidecar:status", handler)
    return () => ipcRenderer.removeListener("sidecar:status", handler)
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

export type ElectronAPI = typeof electronAPI;
