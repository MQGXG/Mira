/**
 * 用户模型配置加载（一切皆插件：用户层 JSON 数据源）
 *
 * 全局文件：`~/.config/mira/models.json`（与 `~/.config/mira/agents/` 同根）
 *
 * 结构：
 * ```json
 * {
 *   "providers": [ ...完整 ProviderDef（新增 provider / 覆盖内置，含 capabilities）... ],
 *   "overrides": { "providerId": { "baseUrl": "...", "models": { "modelId": { "capabilities": ["vision"] } } } }
 * }
 * ```
 * 加载结果由 ProviderCatalog 应用（applyUserDefs + applyUserConfig）。
 */
import * as fs from "fs"
import * as path from "path"
import { homedir } from "os"
import type { ProviderDef } from "../llm/builtin-providers"
import type { ProviderUserConfig } from "../llm/provider-catalog"

export interface UserModelConfig {
  /** 完整 provider 定义（新增 provider 或整体覆盖内置，含模型能力） */
  providers?: ProviderDef[]
  /** 对已注册 provider 的能力/地址等增量覆盖 */
  overrides?: Record<string, ProviderUserConfig>
}

export function getGlobalModelConfigPath(): string {
  return path.join(homedir(), ".config", "mira", "models.json")
}

function isValidProvider(d: unknown): d is ProviderDef {
  const o = d as ProviderDef | null | undefined
  return !!o
    && typeof o.id === "string"
    && typeof o.label === "string"
    && typeof o.protocol === "string"
    && Array.isArray(o.models)
}

/** 读取并解析用户模型配置；文件不存在 / 解析失败返回空配置（不抛错） */
export function loadUserModelConfig(filePath: string = getGlobalModelConfigPath()): UserModelConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as UserModelConfig
    const providers = Array.isArray(raw.providers) ? raw.providers.filter(isValidProvider) : []
    const overrides =
      raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides)
        ? raw.overrides
        : {}
    return { providers, overrides }
  } catch {
    return { providers: [], overrides: {} }
  }
}