/**
 * Agent Core — 类似 OpenCode 的 core 包
 * TypeScript 工具系统 + Agent 循环，在 Electron 主进程运行
 */

// 运行期自修改（"一切皆插件"终局：Agent 定义/激活/卸载自己的插件）
export { setupSelfModification, SELF_MOD_TOOLS, DynamicPluginRunner, DynamicPluginRegistry } from "./selfmod"
export type { RunResult, SelfModConfig, DynamicPlugin, DynamicPackage, PluginId, PackageId } from "./selfmod"
export { precheckCode, evaluateHostCode, createSandbox, buildCtxFacade } from "./selfmod"
export type { CtxFacade } from "./selfmod/sandbox"

export { Agent } from "./agent/agent"
export type { AgentConfig } from "./agent/agent"
export type { PermissionReply } from "./agent/agent"
export type { AgentEvent } from "./types"
// 统一错误分类
export {
  MiraError,
  invalidRequest, authError, rateLimitError, quotaError, contentPolicyError,
  timeoutError, transportError, providerError,
  toolNotFoundError, toolExecutionError, toolInvalidArgsError,
  permissionDeniedError, sessionNotFoundError, contextOverflowError,
  dbError, fsError, internalError,
  isMiraError, getErrorCode, isRetryableError,
  type MiraErrorCode,
} from "./shared/errors"
export { LLMError } from "./llm/schema/errors"
export { ToolRegistry, type ModelFilter } from "./system/registry"
export { make, withPermission, settle, truncateToolOutput } from "./shared/tool"
export { PermissionSet, defaultPermissions, permissionsForMode, type PermissionRule } from "./system/permission"
export { type AgentMode, getModeConfig, getAllModes, modeToPermissionSet, loadCustomAgents, registerAgent, registerAgentFromJson, getModeToolAllowlist } from "./config/modes"
export { type AgentProfile, AgentProfileRegistry, getGlobalAgentDir, getProjectAgentDir } from "./config/profile"
export { ContextManager, type ContextConfig, type ContextStats } from "./session/context"
export { GoalJudge, type Goal, type GoalConfig, type GoalEvaluation } from "./orchestrate/goal-judge"
export { createLLMClient } from "./llm/client"
export type { SDKConfig as ClientConfig } from "./llm/client"
export type { LLMMessage } from "./llm/schema/messages"
export type { ToolDef, ToolContext, ToolResult, ToolCall, Content, Settlement, TruncatedOutput, TruncateOutputOptions } from "./shared/tool"
export * as ToolEffect from "./shared/tool-effect"
export { lspManager } from "./lsp/manager"

// 工具
export {
  readFileTool as readFileToolEffect,
} from "./tools/core/read-file-effect"
export {
  writeFileTool,
  listFilesTool,
  webSearchTool,
  grepTool,
  globTool,
  codeExecTool, bashTool, editFileTool,
} from "./tools/index"

// Skill 工具
export { skillsListTool, skillViewTool } from "./skill/skill-tools"

// 数据分析工具
export { dataAnalysisTool } from "./tools/knowledge/data-analysis"
// 图表生成工具
export { createChartTool } from "./tools/knowledge/create-chart"
// 浏览器自动化
export { webBrowseTool } from "./tools/knowledge/web-browse"
// Cron 定时任务工具
export { cronTool } from "./tools/orchestrate/cron-tool"
// 任务规划工具
export { taskTool } from "./tools/orchestrate/task-tool"
// 委派任务工具
export { delegateTaskTool } from "./tools/orchestrate/delegate-task"
// 历史搜索工具
export { searchHistoryTool } from "./tools/core/search-history"
// 图片生成工具
export { imageGenTool } from "./tools/execution/image-gen"
// Workflow 工具
export { workflowRunTool } from "./tools/orchestrate/workflow-tool"
export { WorkflowEngine } from "./workflow/index"
export type { WorkflowDefinition, WorkflowStep, WorkflowResult } from "./workflow/index"
// Worktree 工具
export { worktreeTool } from "./tools/orchestrate/worktree-tool"
// 团队工具
export { teamTool } from "./tools/orchestrate/team-tool"
// LSP 工具
export { lspDefinitionTool, lspReferencesTool, lspHoverTool, lspSymbolsTool, lspImplementationsTool, lspRenameTool } from "./tools/infra/lsp-tool"

// 系统模块
export { cronScheduler } from "./background/cron"
export { scanSkills } from "./skill/skill-loader"
export { ComposeModeManager, type ComposePhase, type ComposeState } from "./compose-mode"
export { DreamDistillManager } from "./orchestrate/dream"
export { invariantRegistry, registerDefaultInvariants, type Invariant, type InvariantContext } from "./invariants"
export { capabilityRegistry, type CapabilityDefinition } from "./capability"
export { getFs, LocalFileSystemProvider, FS_CAPABILITY, defaultFsProvider, type FileSystemProvider, type FsStats, type FsEntry } from "./capability/fs"
export { getSubprocess, LocalSubprocessProvider, SUBPROCESS_CAPABILITY, defaultSubprocessProvider, type SubprocessProvider, type SubprocessResult, type SubprocessOptions } from "./capability/subprocess"
export { getCodeRuntime, LocalCodeRuntimeProvider, CODE_RUNTIME_CAPABILITY, defaultCodeRuntimeProvider, type CodeRuntimeProvider, type CodeRuntimeRequest, type CodeRuntimeResult } from "./capability/code-runtime"
export { getShell, LocalShellProvider, SHELL_CAPABILITY, defaultShellProvider, type ShellProvider } from "./capability/shell"
export { getSandbox, NoopSandboxProvider, SANDBOX_CAPABILITY, defaultSandboxProvider, type SandboxProvider, type SandboxedCommand, type SandboxOptions } from "./capability/sandbox"
export { getOffice, OFFICE_CAPABILITY, type OfficeProvider, type OfficeResult, type OfficeRunOptions } from "./capability/office"
export { OfficeCliProvider, createOfficeCliProvider, registerOfficeCapability } from "./capability/office-cli-provider"
export { TaskPlanner } from "./task/planner"
export { PluginHooks, pluginHooks } from "./shared/plugin-hooks"
export { SubagentManager, type SubagentInfo, type SubagentStatus, type SubagentEvent, type SubagentEventType } from "./orchestrate/subagent"
export { runDelegate, getDelegationStatus } from "./orchestrate/delegate"
export { setupDefaultHooks } from "./shared/hooks-setup"
export { sendMessage, readInbox } from "./orchestrate/team-bus"
export { createWorktree, listWorktrees } from "./background/worktree"

export { createDefaultRegistry, registerOfficeTools } from "./system/registry-init"
export {
  officecliInspectTool, officecliGetTool, officecliQueryTool,
  officecliIssuesTool, officecliValidateTool, officecliEditTool, officecliMergeTool,
} from "./tools/office/officecli-tools"

// 配置系统
export { loadConfig, saveGlobalConfig, resolveRuntimeConfig, getConfigForRenderer } from "./config/index"
export type { MiraConfig, ResolvedConfig } from "./config/index"
// Bundle/patch 配置组合（对齐 dsh Profile → Bundle → patch）
export { BundleRegistry, bundleRegistry, deepMerge } from "./config/bundle"
export type { BundleDef, BundlePluginRef, BundlePatchFile, BundleResolveResult } from "./config/bundle"

// 语音引擎用户配置（voice.json 读写）
export { saveUserVoiceDefaults, loadUserVoiceConfig, getGlobalVoiceConfigPath } from "./config/voice-config"
export type { UserVoiceConfig } from "./config/voice-config"

// 平台路径抽象
export { initPlatformPaths, getPlatformPaths } from "./config/paths"
export type { PlatformPaths } from "./config/paths"

// Sidecar 服务
export { ServerManager } from "./system/server-manager"
export type { ServerManagerOptions } from "./system/server-manager"
export { createServer, startServer } from "./system/server"
export type { ServerOptions } from "./system/server"
export type { APIContext } from "./system/server"

// 新模块
export { featureFlags, isFeatureEnabled } from "./config/flags"
export { SnapshotManager } from "./session/snapshot"
export { SessionForkManager } from "./session/fork"
export { ForkCacheManager } from "./agent/fork-cache"
export { SystemContextManager } from "./agent/system-context"
export { ContextEpochTracker, getContextEpochTracker, type ContextEpoch } from "./session/context-epoch"
export { TextNgramMonitor } from "./agent/text-ngram"
export { searchTools, getRecommendedTools, shouldLoadTool } from "./tools/shared/tool-loader"
export { ProviderCatalog } from "./llm/provider-catalog"
export type { ProviderDef, ModelDef } from "./llm/provider-catalog"

// Graph Engineering
export {
  StateGraph, type GraphRunOptions,
  StateStore, GraphPersist,
  type GraphDefinition, type GraphNode, type GraphEdge, type GraphState,
  type GraphStateSchema, type GraphNodeKind, type GraphNodeContext,
  type GraphNodeResult, type GraphRunResult, type GraphCheckpoint,
  type GraphConditionBranch, type AnchorRule, type StateUpdateStrategy,
} from "./graph"
export { runCodingTask, buildCodingTaskGraph, type CodingTaskOptions } from "./graph/templates/coding-task"

// 动态记忆图谱
export { DynamicMemoryManager, createDynamicMemory } from "./memory/dynamic-memory"
export { calculateStrength, updateStrengthAfterAccess, rankScore } from "./memory/memory-strength"
export { retentionRate, decayStrength, forgettingCurveData, spacedRepetitionCurve } from "./memory/decay-curve"
export { activateMemory, simpleTextRelevance, semanticRelevance } from "./memory/memory-activation"
export {
  type MemoryNode, type MemoryEdge, type MemoryGraph, type ActivationResult,
  type DecayConfig, type MemoryType, createMemoryNode, createMemoryEdge, createEmptyGraph,
  DECAY_PROFILES,
} from "./memory/memory-node"
// 会话结束自动记忆提取
export {
  MemoryExtractor, createExtractorLlmCall, parseOps, cleanFact,
  transcriptLines, containsSensitiveContent,
  EXTRACTOR_SYSTEM_PROMPT, SENSITIVE_PATTERNS,
  type MemoryExtractorOptions, type ExtractorLlmCall,
  type MemoryExtractorStore, type ExtractedMessage,
} from "./memory/memory-extractor"

export { memoryActivateTool, setDynamicMemoryManager, getDynamicMemoryManager } from "./tools/knowledge/memory-activate"
export {
  memoryGraphAddNodeTool, memoryGraphAddEdgeTool, memoryGraphQueryTool, memoryGraphDecayTool,
} from "./tools/knowledge/memory-graph"

// ACP (Agent Communication Protocol)
export {
  // 类型
  type ACPCard,
  type ACPCapabilities,
  type ACPMessage,
  type ACPMessageRole,
  type ACPContent,
  type ACPContentType,
  type ACPToolCall,
  type ACPToolCallStatus,
  type ACPToolResult,
  type ACPMessageMetadata,
  type ACPTokenUsage,
  type ACPTask,
  type ACPTaskType,
  type ACPTaskStatus,
  type ACPTaskInput,
  type ACPTaskOutput,
  type ACPTaskMetadata,
  type ACPEvent,
  type ACPEventType,
  type ACPPermissionRequest,
  type ACPPermissionDecision,
  type ACPSession,
  type ACPSessionStatus,
  type ACPDecision,
  type ACPDecisionMode,
  type ACPPresentation,
  type ACPInlineContent,
  type ACPDelegation,
  type ACPWork,
  type ACPWorkStatus,
  type ACPConfig,
  type ACPToolContext,
  type ACPToolExecutor,
  type ACPToolDefinition,

  // 消息工具函数
  createTextMessage,
  createMultiContentMessage,
  createToolCallMessage,
  createToolResultMessage,
  createSystemMessage,
  createUserMessage,
  createAssistantMessage,
  createTextContent,
  createCodeContent,
  createImageContent,
  createAudioContent,
  createFileContent,
  createToolCall,
  createToolResult,
  extractTextFromMessage,
  extractCodeFromMessage,
  getToolCallsFromMessage,
  getToolResultsFromMessage,
  toLLMMessage,
  toLLMMessages,
  validateMessage,
  validateMessages,

  // Work 状态机
  WorkStateMachine,
  globalWorkStateMachine,
  generateWorkId,
  isTerminalStatus,
  isActiveStatus,
  getStatusLabel,
  getStatusColor,
} from "./orchestrate/acp"

// 语音交互模块
export {
  // 类型
  type STTType,
  type TTSType,
  type VoiceEngineKind,
  type VoiceEngineImplementation,
  type VoiceEngineDef,
  type STTEngine,
  type TTSEngine,
  type VADResult,
  type VADOptions,
  type VADController,
  type STTEngineFactory,
  type TTSEngineFactory,
  type VADEngineFactory,

  type VADConfig,
  type VADEvent,
  type VADEventType,
  type VADState,
  type STTConfig,
  type STTResult,
  type STTEvent,
  type STTEventType,
  type TTSConfig,
  type TTSResult,
  type TTSEvent,
  type TTSEventType,
  type VoiceSessionConfig,
  type VoiceSessionState,
  type VoiceSessionEvent,
  type VoiceSessionEventType,
  type InterruptionConfig,
  type InterruptionEvent,
  type VoiceManagerConfig,
  type VoiceManagerEvent,
  type VoiceManagerEventType,

  // 类
  VoiceSessionManager,

  // 引擎实现
  BUILTIN_ENGINE_FACTORIES,
  createWhisperSTTEngine,
  DEFAULT_WHISPER_MODEL,
  createWebSpeechSTTEngine,
  createKokoroTTSEngine,
  DEFAULT_KOKORO_MODEL,
  createWebSpeechTTSEngine,
  createEnergyVADEngine,
  DEFAULT_ENERGY_VAD_PARAMS,

  // 音频/模型加载工具
  float32ToAudioBuffer,
  playFloat32,
  startMicRecording,
  getCurrentVolume,
  recordChunk,
  mergeChunks,
  loadASRPipeline,
  loadTTSPipeline,
  type ASRPipeline,
  type TTSPipeline,

  // 引擎目录
  VoiceRegistry,
} from "./voice"

// 引擎目录 Node 加载器（主进程/sidecar 生产链路初始化；含 fs，不进 renderer 纯入口）
export { initVoiceCatalog, loadBuiltinVoiceCatalog, applyUserVoiceConfig } from "./voice/catalog-loader"

// Node 侧语音模块（依赖 Node events/fs，仅在主进程/sidecar 使用）
export { VoiceActivityDetector } from "./voice/vad"
export { InterruptionManager } from "./voice/interruption"
export { AnnouncementWindow } from "./voice/announcement-window"
export type { ResponseInfo, SpeechOrigin } from "./voice/announcement-window"





