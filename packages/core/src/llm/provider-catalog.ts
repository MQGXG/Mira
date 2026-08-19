import { LLMError } from "./schema"
import { OpenAIChatProtocol } from "./protocols/openai-chat"
import { AnthropicMessagesProtocol } from "./protocols/anthropic-messages"
import { OpenAICompatibleChatProtocol } from "./protocols/openai-compatible-chat"
import { GeminiProtocol } from "./protocols/gemini"
import { OpenAIResponsesProtocol } from "./protocols/openai-responses"
import { makeRoute } from "./route/route"
import type { RouteInstance } from "./route/types"
import type { Auth, Endpoint, Framing, Protocol } from "./route/types"
import { BUILTIN_PROVIDERS, type ProviderDef, type ModelDef } from "./builtin-providers"
import { loadUserModelConfig } from "../config/models-config"

export type { ProviderDef, ModelDef } from "./builtin-providers"

export interface ProviderUserConfig {
  apiKey?: string
  baseUrl?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
  enabled?: boolean
  models?: Record<string, { name?: string; enabled?: boolean; context?: number; capabilities?: string[] }>
}

const providers = new Map<string, ProviderDef>()
const userConfigs = new Map<string, ProviderUserConfig>()
let initialized = false

function getProtocol(protocolName: string): Protocol {
  switch (protocolName) {
    case "openai-chat": return OpenAIChatProtocol
    case "anthropic-messages": return AnthropicMessagesProtocol
    case "openai-compatible": return OpenAICompatibleChatProtocol
    case "gemini": return GeminiProtocol
    case "openai-responses": return OpenAIResponsesProtocol
    // 别名容错：用户/插件配置可能使用简写协议名
    case "openai": return OpenAICompatibleChatProtocol
    case "anthropic": return AnthropicMessagesProtocol
    default: throw LLMError.invalidRequest(`Unknown protocol: ${protocolName}`)
  }
}

function getEndpoint(def: ProviderDef, baseUrl?: string): Endpoint {
  const url = baseUrl || def.defaultBaseUrl
  // 别名（openai/anthropic 简写）与全名统一判定默认 path
  const isAnthropic = def.protocol === "anthropic-messages" || def.protocol === "anthropic"
  const path = def.path || (isAnthropic ? "/v1/messages" : "/chat/completions")
  return { baseUrl: url, path }
}

function getAuth(def: ProviderDef, apiKey: string): Auth {
  if (def.authType === "none") return { type: "none" }
  if (def.authType === "api-key") {
    return { type: "api-key", key: apiKey, header: def.authHeader || "x-api-key" }
  }
  return { type: "bearer", token: apiKey }
}

function getExtraHeaders(def: ProviderDef): Record<string, string> | undefined {
  if (!def.versionHeader) return undefined
  return { [def.versionHeader.name]: def.versionHeader.value }
}

export class ProviderCatalog {
  static registerBuiltins(): void {
    // 幂等：已初始化直接返回，避免重复注册
    if (initialized) return
    for (const def of BUILTIN_PROVIDERS) {
      providers.set(def.id, { ...def, models: [...def.models] })
    }
    initialized = true
  }

  private static userConfigApplied = false

  /** 应用用户层 models.json（新增 provider / 覆盖内置能力）。幂等。 */
  static applyUserModelConfig(): void {
    if (ProviderCatalog.userConfigApplied) return
    ProviderCatalog.userConfigApplied = true
    const userConfig = loadUserModelConfig()
    ProviderCatalog.applyUserDefs(userConfig.providers || [])
    ProviderCatalog.applyUserConfig(userConfig.overrides || {})
  }

  /**
   * 完整初始化入口：内置目录 + 用户层 models.json + 插件注册。
   * 生产链路（agent 循环 / IPC / createRoute）统一走此入口；
   * 测试直接调用 registerBuiltins 以隔离用户配置文件。
   */
  static initProviderCatalog(): void {
    ProviderCatalog.registerBuiltins()
    ProviderCatalog.applyUserModelConfig()
  }

  static register(id: string, def: ProviderDef): void {
    providers.set(id, { ...def, models: [...def.models] })
  }

  static unregister(id: string): boolean {
    return providers.delete(id)
  }

  static getProvider(id: string): ProviderDef | undefined {
    return providers.get(id)
  }

  static getModel(providerId: string, modelId: string): ModelDef | undefined {
    const prov = providers.get(providerId)
    return prov?.models.find(m => m.id === modelId)
  }

  static listProviders(): ProviderDef[] {
    return Array.from(providers.values())
  }

  static listModels(providerId?: string): ModelDef[] {
    if (providerId) return providers.get(providerId)?.models ?? []
    const all: ModelDef[] = []
    for (const p of providers.values()) all.push(...p.models)
    return all
  }

  static applyUserConfig(configs: Record<string, ProviderUserConfig>): void {
    for (const [id, cfg] of Object.entries(configs)) {
      userConfigs.set(id, cfg)
      const existing = providers.get(id)
      if (existing) {
        if (cfg.baseUrl) existing.defaultBaseUrl = cfg.baseUrl
        if (cfg.models) {
          for (const [mid, mc] of Object.entries(cfg.models)) {
            const model = existing.models.find(m => m.id === mid)
            if (!model) continue
            if (mc.name) model.label = mc.name
            if (mc.context !== undefined) model.context = mc.context
            if (mc.capabilities) model.capabilities = [...new Set([...(model.capabilities || []), ...mc.capabilities])]
          }
        }
      }
    }
  }

  /**
   * 注册用户自定义 provider（完整定义，含模型能力）。
   * 用于用户层 models.json / 插件层，可覆盖内置 provider。
   */
  static applyUserDefs(defs: ProviderDef[]): void {
    for (const def of defs) {
      if (!def || typeof def.id !== "string" || !Array.isArray(def.models)) continue
      providers.set(def.id, { ...def, models: [...def.models] })
    }
  }

  static getUserConfig(id: string): ProviderUserConfig | undefined {
    return userConfigs.get(id)
  }

  static createRoute(providerId: string, apiKey: string, baseUrl?: string, extraHeaders?: Record<string, string>): RouteInstance {
    if (!initialized) ProviderCatalog.initProviderCatalog()
    const def = providers.get(providerId)
    if (!def) {
      if (baseUrl) {
        return makeRoute({
          protocol: OpenAICompatibleChatProtocol,
          endpoint: { baseUrl, path: "/chat/completions" },
          auth: { type: "bearer", token: apiKey },
          framing: "sse",
          headers: extraHeaders,
        })
      }
      throw LLMError.invalidRequest(`Unknown provider: ${providerId}`)
    }

    const endpoint = getEndpoint(def, baseUrl)
    const auth = getAuth(def, apiKey)
    const versionHeaders = getExtraHeaders(def)
    const userCfg = userConfigs.get(providerId)
    const configHeaders = userCfg?.headers

    try {
      return makeRoute({
        protocol: getProtocol(def.protocol),
        endpoint,
        auth,
        framing: def.framing || "sse",
        headers: { ...versionHeaders, ...configHeaders, ...extraHeaders },
      })
    } catch (err) {
      throw LLMError.provider(providerId, `Failed to create route: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  static getCatalogForUI(): Array<{
    id: string; label: string; website?: string
    defaultBaseUrl: string; authType: string
    models: Array<{ id: string; label?: string; context?: number; capabilities?: string[] }>
  }> {
    return Array.from(providers.values()).map(p => ({
      id: p.id, label: p.label, website: p.website,
      defaultBaseUrl: p.defaultBaseUrl, authType: p.authType,
      models: p.models.map(m => ({ id: m.id, label: m.label, context: m.context, capabilities: m.capabilities })),
    }))
  }

  static isInitialized(): boolean {
    return initialized
  }
}
