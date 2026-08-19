/**
 * @mira/ui - Mira UI 组件包
 *
 * 包含所有 React UI 组件
 */

// ─── Service 层 ────────────────────────────────────────────────
export { SessionService } from "./services/session.service"
export { ProjectService } from "./services/project.service"
export { AgentService } from "./services/agent.service"
export { ConfigService } from "./services/config.service"
export { MemoryService } from "./services/memory.service"
export type { SessionInfo, SessionMessage, SearchResult } from "./services/session.service"
export type { ProjectInfo } from "./services/project.service"
export type { ToolInfo, ToolResult, SkillInfo } from "./services/agent.service"
export type { ConfigInfo } from "./services/config.service"
export type { MemoryEntry } from "./services/memory.service"

// ─── 通用 UI 组件 ──────────────────────────────────────────────
export { Modal } from "./components/ui/Modal"
export { CommandPalette } from "./components/CommandPalette"

// ─── 聊天组件 ──────────────────────────────────────────────────
export { ChatWindow } from "./chat/ChatWindow"
export { MiraRuntimeProvider } from "./chat/MiraRuntimeProvider"
export { ModelSelector } from "./chat/ModelSelector"
export { PermissionDialog } from "./chat/PermissionDialog"
export { QuestionDialog } from "./chat/QuestionDialog"
export { MarkdownText } from "./components/assistant-ui/markdown-text"
export { ThinkingBlock, ReasoningBlock, ThinkingShimmer } from "./chat/ThinkingBlock"
export { ToolCallView } from "./chat/ToolCallView"
export { ToolPalette } from "./chat/ToolPalette"
export { VoiceInput } from "./chat/VoiceInput"
export { VoiceChatButton } from "./chat/VoiceChatButton"

// ������ ������� ����������������������������������������������������������������������������������������������������
export { RealtimeVoice, type RealtimeStatus } from "./services/voice/realtime-voice"
export { createTTSEngine, createDefaultTTSEngine, createLocalEngine, createWebSpeechEngine } from "./services/voice/tts"
export { createSTTEngine, WHISPER_MODEL } from "./services/voice/stt"
export { loadASRPipeline, loadTTSPipeline } from "./services/voice/transformers-loader"
export type { TTSEngine, TTSType, STTEngine, STTType, VADResult } from "./services/voice/types"
export { LipSyncEngine, LIP_KEYS, type LipKey, type LipSyncOutput, type LipSyncInput } from "./services/voice/lip-sync"
export { PetMotionManager, approach, type ActionPlugin, type MotionAction, type MotionContext } from "./services/voice/motion-manager"
export { motionPresetPlugin, idleBlinkPlugin, idleBreathPlugin, defaultPetPlugins, MOTION_PRESETS } from "./services/voice/motion-plugins"
export { MiraLogo } from "./chat/MiraLogo"
export { MessageTiming } from "./components/assistant-ui/message-timing"
export { Reasoning, ReasoningGroup } from "./components/assistant-ui/reasoning"
export { ToolFallback } from "./components/assistant-ui/tool-fallback"
export { ToolGroup } from "./components/assistant-ui/tool-group"
export { DiffViewer } from "./components/assistant-ui/diff-viewer"
export { ContextDisplay } from "./components/assistant-ui/context-display"

// ─── 侧边栏组件 ───────────────────────────────────────────────
export { Sidebar } from "./sidebar/Sidebar"
export { SettingsDialog } from "./sidebar/SettingsDialog"
export { ModelManager } from "./sidebar/ModelManager"
export { ProjectBar } from "./sidebar/ProjectBar"
export { ThemeSelector } from "./sidebar/ThemeSelector"
export { ProviderConfigPanel } from "./sidebar/ProviderConfigPanel"

// ─── 知识图谱 ──────────────────────────────────────────────────
export { MemoryGraph } from "./memory/MemoryGraph"
export { GraphPanel } from "./memory/GraphPanel"
export type { GraphNode, GraphLink, GraphData } from "./memory/graph-data"

// ─── 数据语义色板（统一出口）───────────────────────────────────
export {
  GRAPH_NODE_COLORS,
  MEMORY_TYPE_COLORS,
  GRAPH_ACTIVATION_COLOR,
  GRAPH_LINK_COLORS,
  GRAPH_LINK_PARTICLE_COLORS,
  PROJECT_COLORS,
  DEFAULT_PROJECT_COLOR,
} from "./theme/data-colors"

// ─── 布局组件 ──────────────────────────────────────────────────
export { TitleBar } from "./layout/TitleBar"

// ─── React Hooks ───────────────────────────────────────────────
export { useMiraChat } from "./hooks/useMiraChat"

// ─── 主题上下文 ────────────────────────────────────────────────
export { ThemeProvider, useTheme } from "./contexts/ThemeContext"

// ─── 类型定义 ──────────────────────────────────────────────────
export type { AgentMode } from "@mira/core/config/modes"
