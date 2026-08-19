/**
 * Mira Context 引导 — 创建根 Context 并注册核心服务
 *
 * 阶段 1：catalog / config（无状态轻量服务）。
 * 阶段 2：llm / tools / permissions / sessions / memory / dynamicMemory / mcp。
 */

import { Context } from "../vendor/cordis/index"
import { ProviderCatalog } from "../llm/provider-catalog"
import type { CatalogService, ConfigService } from "./context"
import type { AgentConfig } from "../agent/constants"
import { MiraLLMService } from "../services/llm"
import { MiraToolService } from "../services/tools"
import { MiraPermissionService } from "../services/permissions"
import { MiraSessionService } from "../services/sessions"
import { MiraMemoryService } from "../services/memory"
import { MiraDynamicMemoryService } from "../services/dynamic-memory"
import { MiraMCPService } from "../services/mcp"
import { MiraAgentLoop } from "../services/agent-loop"
import { MiraAgentRegistry } from "../services/agents"
import { MiraSystemPromptService } from "../services/system-prompt"
import { MiraFileSystemService, MiraSubprocessService, MiraShellService } from "../services/capability"
import { MiraWorkflowService } from "../services/workflow"
import { MiraSkillService } from "../services/skill"
import { MiraLSPService } from "../services/lsp"
import { MiraBackgroundService } from "../services/background"
import { MiraTaskService } from "../services/task"
import { MiraGoalService } from "../services/goal"
import { MiraDreamService } from "../services/dream"
import { MiraSubagentService } from "../services/subagent"
import { MiraComposeService } from "../services/compose"
import { MiraGraphService } from "../services/graph"
import { MiraVoiceService } from "../services/voice"
import type { PermissionRule } from "../system/permission"
import { pluginHooks } from "../shared/plugin-hooks"
import { registerConvergenceGuard } from "../agent/convergence-guard"

/** Provider 目录服务：静态 ProviderCatalog 的实例化视图 */
class MiraCatalogService implements CatalogService {
  init(): void {
    ProviderCatalog.initProviderCatalog()
  }
  register(def: Parameters<CatalogService["register"]>[0]): void {
    ProviderCatalog.register(def.id, def)
  }
  getModel(providerId: string, modelId: string) {
    return ProviderCatalog.getModel(providerId, modelId)
  }
  listModels(providerId?: string) {
    return ProviderCatalog.listModels(providerId)
  }
}

/** 全局配置服务：运行时固定（由调用方装配） */
class MiraConfigService implements ConfigService {
  constructor(private base: Partial<AgentConfig> = {}) {}
  getWorkspace(): string {
    return this.base.workspace || ""
  }
  getMode() {
    return this.base.mode || "assistant"
  }
  getConfig(): AgentConfig {
    return this.base as AgentConfig
  }
}

/** 引导选项：一次性装配的服务依赖 */
export interface MiraContextOptions {
  baseConfig?: Partial<AgentConfig>
  /** 初始权限规则（可选） */
  permissions?: PermissionRule[]
  /** 注入共享 ToolRegistry（sidecar 链路复用 createDefaultRegistry，让工具单一寻址） */
  toolsRegistry?: import("../system/registry").ToolRegistry
}

/**
 * 创建 Mira 根 Context 并注册核心服务（Cordis 插件化装配）。
 * 对齐 dsh boot：每个服务作为独立插件经 ctx.plugin() 加载，
 * static inject 声明依赖、Fiber 按依赖图延迟激活、卸载自动回滚。
 * @param options 引导选项
 */
export async function createMiraContext(options: MiraContextOptions = {}): Promise<Context> {
  const ctx = new Context()
  const { baseConfig, permissions, toolsRegistry } = options

  // 轻量服务（无依赖，直接 provide）
  ctx.provide("catalog", new MiraCatalogService())
  ctx.provide("config", new MiraConfigService(baseConfig))

  // 核心服务（Cordis 插件：inject 依赖驱动 + Fiber 生命周期）
  await ctx.plugin(MiraToolService, { registry: toolsRegistry })
  await ctx.plugin(MiraPermissionService, { rules: permissions })
  await ctx.plugin(MiraSessionService)
  await ctx.plugin(MiraMemoryService)
  await ctx.plugin(MiraDynamicMemoryService)
  await ctx.plugin(MiraLLMService)
  await ctx.plugin(MiraMCPService)
  await ctx.plugin(MiraAgentRegistry)
  await ctx.plugin(MiraSystemPromptService)
  await ctx.plugin(MiraAgentLoop)

  // Capability Seams（Definition + 默认本地 Provider，可替换）
  await ctx.plugin(MiraFileSystemService)
  await ctx.plugin(MiraSubprocessService)
  await ctx.plugin(MiraShellService)

  // 特色功能服务（引擎持有 + 可替换，插件经 ctx 寻址）
  await ctx.plugin(MiraWorkflowService)
  await ctx.plugin(MiraSkillService)
  await ctx.plugin(MiraLSPService)
  await ctx.plugin(MiraBackgroundService)
  await ctx.plugin(MiraTaskService)
  await ctx.plugin(MiraGoalService)
  await ctx.plugin(MiraDreamService)
  // subagent 依赖 tools（registry）；compose 依赖 subagent（自动接线 setSubagentManager）
  await ctx.plugin(MiraSubagentService, { maxParallel: 5 })
  await ctx.plugin(MiraComposeService)
  await ctx.plugin(MiraGraphService)
  await ctx.plugin(MiraVoiceService)

  // 服务快照提升：把各装配 fiber 的服务 impl 提升到 root fiber.store，
  // 使作用域 ctx（scope fiber）沿父链（→root fiber）也能解析服务。
  // 对齐 dsh loopCtx 语义：scope 铸造 ctx 能经父链快照解析全部服务。
  const rootStore = ctx.fiber.store
  if (rootStore) {
    for (const runtime of ctx.registry.values()) {
      for (const fiber of runtime.fibers) {
        if (fiber.store) {
          for (const name of Object.keys(fiber.store)) {
            rootStore[name] = fiber.store[name]
          }
        }
      }
    }
  }

  // 遗留插件 hook 薄包装绑定到根 ctx：旧 pluginHooks.on("pre_llm" 等) 转发到 dsh 命名事件
  pluginHooks.bindCtx(ctx)

  // 回合级收敛保护（loop-hygiene）默认插件：连续纯工具回合强制总结（4 搜索 / 8 其他）
  registerConvergenceGuard(ctx)

  return ctx
}
