/**
 * Mira 插件框架适配层 — 统一导出
 *
 * 将 vendored Cordis 框架与 Mira 服务注册表、类型化事件集成。
 * 阶段 1：类型层 + 引导；阶段 2：核心服务实现。
 */

// vendored Cordis 框架（rescope 为相对路径源码引入）
export {
  Context,
  Service,
  symbols,
  type Events,
  type EventOptions,
  type Plugin,
  type Inject,
  type InjectKey,
  type FiberState,
  type DispatchMode,
} from "../vendor/cordis/index"

// Mira Context 服务注册表扩展
export type {
  LLMService,
  ToolService,
  PermissionService,
  SessionService,
  MemoryService,
  DynamicMemoryService,
  MCPService,
  CatalogService,
  ConfigService,
  AgentLoopService,
  AgentRegistryService,
  SystemPromptService,
} from "./context"
export type {
  AgentFactory,
  AgentHandle,
  CreateAgentOptions,
  ResumeAgentOptions,
  AgentSetup,
  AgentSetupCommit,
} from "./context"

// Mira 类型化事件
export { MiraEvents } from "./events"
export type { MiraEventName } from "./events"

// 服务注册引导（阶段 2 实现）
export { createMiraContext } from "./services"
export type { MiraContextOptions } from "./services"

// 插件系统（Cordis Registry + 旧插件桥接）
export { MiraPluginManager } from "./plugins"
export { adaptMiraPlugin } from "./plugin-adapter"
