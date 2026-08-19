import * as fs from "fs"
import * as path from "path"
import type { Framing } from "./route/types"

export interface ModelDef {
  id: string
  label?: string
  context?: number
  output?: number
  capabilities?: string[]
  cost?: { inputPer1K: number; outputPer1K: number }
}

export interface ProviderDef {
  id: string
  label: string
  protocol: "openai-chat" | "anthropic-messages" | "openai-compatible" | "gemini" | "openai-responses" | "openai" | "anthropic"
  defaultBaseUrl: string
  authType: "bearer" | "api-key" | "oauth" | "none"
  authHeader?: string
  defaultModel?: string
  models: ModelDef[]
  versionHeader?: { name: string; value: string }
  path?: string
  framing?: Framing
  website?: string
}

/**
 * 内置模型目录加载器。
 *
 * 数据源为 `resources/models/model-catalog.json`（可插拔数据，一切皆插件）：
 * - 打包后：`process.resourcesPath/models/model-catalog.json`（electron-builder extraResources）
 * - 开发/测试：`{cwd}/resources/models/model-catalog.json`
 *
 * 解析失败时回退为空目录并告警，避免启动崩溃。
 */
function findCatalogPath(): string | null {
  const candidates: string[] = []
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(path.join(resourcesPath, "models", "model-catalog.json"))
  candidates.push(path.join(process.cwd(), "resources", "models", "model-catalog.json"))
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch { /* 忽略不可访问路径 */ }
  }
  return null
}

function isProviderDef(d: unknown): d is ProviderDef {
  const o = d as ProviderDef | null | undefined
  return !!o
    && typeof o.id === "string"
    && typeof o.label === "string"
    && typeof o.protocol === "string"
    && typeof o.defaultBaseUrl === "string"
    && Array.isArray(o.models)
}

function loadBuiltinProviders(): ProviderDef[] {
  const catalogPath = findCatalogPath()
  if (!catalogPath) {
    console.warn("[builtin-providers] model-catalog.json 未找到，内置目录为空")
    return []
  }
  try {
    const raw = JSON.parse(fs.readFileSync(catalogPath, "utf-8")) as { providers?: unknown[] }
    const list = Array.isArray(raw.providers) ? raw.providers : []
    return list.filter(isProviderDef)
  } catch (err) {
    console.warn("[builtin-providers] model-catalog.json 解析失败:", err)
    return []
  }
}

export const BUILTIN_PROVIDERS: ProviderDef[] = loadBuiltinProviders()