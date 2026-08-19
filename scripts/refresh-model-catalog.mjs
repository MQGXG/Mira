#!/usr/bin/env node

/**
 * 从 models.dev 公开目录刷新 Mira 的模型目录。
 *
 * 使用方式：
 *   node scripts/refresh-model-catalog.mjs
 *
 * 可选参数：
 *   --dry-run   只打印变更到 stdout，不写文件
 *
 * 数据源：https://models.dev/api.json（公开免费，无需 API key）
 * 覆盖范围：10 个云 provider（ollama/custom 保留现状，不从此源刷新）
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const CATALOG_PATH = resolve(ROOT, "resources/models/model-catalog.json")
const DRY_RUN = process.argv.includes("--dry-run")
const SOURCE_ARG = process.argv.find((_, i, a) => a[i - 1] === "--source")
const MODEL_DEV_URL = "https://models.dev/api.json"

// ── Mira provider → models.dev provider 映射 ───────────────────────

const PROVIDER_MAP = [
  {
    miraId: "openai",
    modelsDevId: "openai",
    label: "OpenAI",
    protocol: "openai-chat",
    defaultBaseUrl: "https://api.openai.com/v1",
    authType: "bearer",
    website: "https://openai.com",
    defaultModel: "gpt-4o",
  },
  {
    miraId: "anthropic",
    modelsDevId: "anthropic",
    label: "Anthropic Claude",
    protocol: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    authType: "api-key",
    authHeader: "x-api-key",
    versionHeader: { name: "anthropic-version", value: "2023-06-01" },
    path: "/v1/messages",
    website: "https://anthropic.com",
    defaultModel: "claude-sonnet-4-20250514",
  },
  {
    miraId: "deepseek",
    modelsDevId: "deepseek",
    label: "DeepSeek",
    protocol: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com",
    authType: "bearer",
    website: "https://deepseek.com",
    defaultModel: "deepseek-chat",
  },
  {
    miraId: "groq",
    modelsDevId: "groq",
    label: "Groq",
    protocol: "openai-compatible",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    authType: "bearer",
    website: "https://groq.com",
    defaultModel: "llama3-70b-8192",
  },
  {
    miraId: "fireworks",
    modelsDevId: "fireworks",
    label: "Fireworks AI",
    protocol: "openai-compatible",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    authType: "bearer",
    website: "https://fireworks.ai",
    defaultModel: "accounts/fireworks/models/llama-v3p1-405b-instruct",
  },
  {
    miraId: "together",
    modelsDevId: "together",
    label: "Together AI",
    protocol: "openai-compatible",
    defaultBaseUrl: "https://api.together.xyz/v1",
    authType: "bearer",
    website: "https://together.ai",
    defaultModel: "mistralai/Mixtral-8x7B-Instruct-v0.1",
  },
  {
    miraId: "cerebras",
    modelsDevId: "cerebras",
    label: "Cerebras",
    protocol: "openai-compatible",
    defaultBaseUrl: "https://api.cerebras.ai/v1",
    authType: "bearer",
    website: "https://cerebras.ai",
    defaultModel: "llama3.1-70b",
  },
  {
    miraId: "perplexity",
    modelsDevId: "perplexity",
    label: "Perplexity",
    protocol: "openai-compatible",
    defaultBaseUrl: "https://api.perplexity.ai",
    authType: "bearer",
    website: "https://perplexity.ai",
    defaultModel: "llama-3.1-sonar-huge-128k-online",
  },
  {
    miraId: "gemini",
    modelsDevId: "google",
    label: "Google Gemini",
    protocol: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    authType: "api-key",
    authHeader: "x-goog-api-key",
    path: "/v1beta/models",
    website: "https://ai.dev",
    defaultModel: "gemini-2.0-flash",
  },
  {
    miraId: "vertex",
    modelsDevId: "google-vertex",
    label: "Vertex AI",
    protocol: "gemini",
    defaultBaseUrl: "https://us-central1-aiplatform.googleapis.com",
    authType: "bearer",
    path: "/v1/projects",
    website: "https://cloud.google.com/vertex-ai",
    defaultModel: "gemini-2.0-flash",
  },
]

// 不从 models.dev 刷新的 provider，保留现状（从现有 JSON 复制）
const PASSTHROUGH_PROVIDERS = ["ollama", "custom"]

// ── 主逻辑 ─────────────────────────────────────────────────────────

async function main() {
  console.log("[models:refresh] 读取现有 model-catalog.json …")
  let existing
  try {
    existing = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"))
  } catch {
    existing = { version: 1, providers: [] }
  }
  const existingProviders = new Map(existing.providers.map((p) => [p.id, p]))

  console.log("[models:refresh] 拉取模型目录 …")
  let catalog
  if (SOURCE_ARG) {
    console.log(`[models:refresh] 使用本地源: ${SOURCE_ARG}`)
    catalog = JSON.parse(readFileSync(resolve(SOURCE_ARG), "utf-8"))
  } else {
    console.log(`[models:refresh] 远程源: ${MODEL_DEV_URL}`)
    const res = await fetch(MODEL_DEV_URL)
    if (!res.ok) throw new Error(`请求失败: ${res.status}`)
    catalog = await res.json()
  }

  const providers = []

  // 刷新从 models.dev 的 provider
  for (const def of PROVIDER_MAP) {
    const source = catalog[def.modelsDevId]
    if (!source?.models) {
      // models.dev 无此 provider，从现有复制
      const existingProvider = existingProviders.get(def.miraId)
      if (existingProvider) {
        providers.push(existingProvider)
        console.log(`  ${def.miraId}: 保留现状（models.dev 无数据）`)
      }
      continue
    }

    const models = []
    for (const [modelId, model] of Object.entries(source.models)) {
      // 过滤：只要支持工具调用的模型
      if (!model.tool_call) continue
      // 过滤废弃模型
      if (model.status === "deprecated") continue

      models.push(mapModel(modelId, model, def))
    }

    // 按 context 降序排（大模型在前）
    models.sort((a, b) => (b.context || 0) - (a.context || 0))

    // 选择 defaultModel：优先用映射表的，若不在 models 里则用第一个
    const defaultModel =
      models.find((m) => m.id === def.defaultModel) || models[0]
    const resolvedDefault = defaultModel?.id || def.defaultModel

    const provider = {
      id: def.miraId,
      label: def.label,
      protocol: def.protocol,
      defaultBaseUrl: def.defaultBaseUrl,
      authType: def.authType,
      ...(def.authHeader ? { authHeader: def.authHeader } : {}),
      ...(def.versionHeader ? { versionHeader: def.versionHeader } : {}),
      ...(def.path ? { path: def.path } : {}),
      defaultModel: resolvedDefault,
      website: def.website,
      models,
    }
    providers.push(provider)
    console.log(
      `  ${def.miraId}: ${models.length} 模型（${models[0]?.label || "?"} → ${models[models.length - 1]?.label || "?"}）`,
    )
  }

  // 保留不变的 provider（ollama/custom）
  for (const id of PASSTHROUGH_PROVIDERS) {
    const existingProvider = existingProviders.get(id)
    if (existingProvider) {
      providers.push(existingProvider)
      console.log(`  ${id}: 保留现状`)
    }
  }

  const result = {
    version: 1,
    updatedAt: new Date().toISOString().slice(0, 10),
    providers,
  }

  if (DRY_RUN) {
    console.log("\n[dry-run] 生成的 catalog（不写文件）：")
    console.log(JSON.stringify(result, null, 2).slice(0, 2000) + "…")
    console.log(`\n[dry-run] ${providers.length} 个 provider，${providers.reduce((s, p) => s + p.models.length, 0)} 个模型`)
  } else {
    writeFileSync(CATALOG_PATH, JSON.stringify(result, null, 2) + "\n", "utf-8")
    console.log(`\n✓ 写入 ${CATALOG_PATH}`)
    console.log(`  ${providers.length} 个 provider，${providers.reduce((s, p) => s + p.models.length, 0)} 个模型`)
  }
}

// ── 模型映射 ───────────────────────────────────────────────────────

function mapModel(modelId, source, providerDef) {
  const capabilities = ["chat"]
  if (source.tool_call) capabilities.push("tool_use")
  if (source.reasoning) capabilities.push("thinking")
  if (source.modalities?.input?.includes("image")) capabilities.push("vision")

  const result = {
    id: modelId,
    label: source.name || modelId,
    context: source.limit?.context || 4096,
    ...(capabilities.length > 1 ? { capabilities } : {}),
  }

  // 成本：models.dev 单位 $/1M tokens → Mira 单位 per1K（÷1000）
  if (source.cost) {
    const input = source.cost.input || 0
    const output = source.cost.output || 0
    if (input > 0 || output > 0) {
      result.cost = {
        inputPer1K: round(input / 1000),
        outputPer1K: round(output / 1000),
      }
    }
  }

  return result
}

function round(n) {
  return Math.round(n * 1_000_000) / 1_000_000 // 6 位小数精度
}

main().catch((err) => {
  console.error(`[models:refresh] 错误: ${err.message}`)
  process.exit(1)
})
