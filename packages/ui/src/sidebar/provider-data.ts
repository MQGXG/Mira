import type { Provider } from "./types";
import { ConfigService } from "../services/config.service";

const ENCRYPTED_PREFIX = "enc:";

async function encryptApiKey(key: string): Promise<string> {
  if (!key) return "";
  try {
    const encrypted = await ConfigService.encryptApiKey(key);
    return ENCRYPTED_PREFIX + encrypted;
  } catch {
    return key;
  }
}

async function decryptApiKey(key: string): Promise<string> {
  if (!key) return "";
  if (key.startsWith(ENCRYPTED_PREFIX)) {
    try {
      const encrypted = key.slice(ENCRYPTED_PREFIX.length);
      return await ConfigService.decryptApiKey(encrypted);
    } catch {
      return key;
    }
  }
  return key;
}

async function encryptProviders(list: Provider[]): Promise<Provider[]> {
  return Promise.all(
    list.map(async (p) => ({ ...p, apiKey: await encryptApiKey(p.apiKey) }))
  );
}

async function decryptProviders(list: Provider[]): Promise<Provider[]> {
  return Promise.all(
    list.map(async (p) => ({ ...p, apiKey: await decryptApiKey(p.apiKey) }))
  );
}

function migrateProviders(data: Array<Record<string, unknown>>): Provider[] {
  return data.map((p) => ({
    ...p,
    id: String(p.id || ""),
    name: String(p.name || ""),
    displayName: String(p.displayName || p.name || ""),
    apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
    enabled: p.enabled !== false,
    website: typeof p.website === "string" ? p.website : undefined,
    apiFormat: (p.apiFormat === "anthropic" || p.apiFormat === "custom" ? p.apiFormat : "openai"),
    headers: (p.headers as Record<string, string>) || {},
    options: (p.options as Record<string, string | number | boolean>) || {},
    models: Array.isArray(p.models) ? (p.models as Array<Record<string, unknown>>).map((m) => ({
      id: String(m.id || ""),
      name: typeof m.name === "string" ? m.name : "",
      enabled: m.enabled !== false,
      type: typeof m.type === "string" && m.type.length > 0 ? m.type : undefined,
    })) : [],
  }));
}

export const defaultProviders: Provider[] = [
  {
    id: "openai", name: "OpenAI", displayName: "OpenAI",
    apiKey: "", baseUrl: "https://api.openai.com/v1", enabled: true,
    website: "https://openai.com", apiFormat: "openai", headers: {}, options: {},
    models: [
      { id: "gpt-4o", name: "GPT-4o", enabled: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", enabled: true },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", enabled: true },
    ],
  },
  {
    id: "claude", name: "Claude", displayName: "Anthropic Claude",
    apiKey: "", baseUrl: "https://api.anthropic.com", enabled: false,
    website: "https://anthropic.com", apiFormat: "anthropic", headers: {}, options: {},
    models: [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", enabled: true },
      { id: "claude-haiku-20241022", name: "Claude Haiku", enabled: true },
    ],
  },
  {
    id: "deepseek", name: "DeepSeek", displayName: "DeepSeek",
    apiKey: "", baseUrl: "https://api.deepseek.com", enabled: false,
    website: "https://deepseek.com", apiFormat: "openai", headers: {}, options: {},
    models: [
      { id: "deepseek-chat", name: "DeepSeek V3", enabled: true },
      { id: "deepseek-reasoner", name: "DeepSeek R1", enabled: true },
    ],
  },
  {
    id: "ollama", name: "Ollama", displayName: "Ollama (本地)",
    apiKey: "", baseUrl: "http://localhost:11434", enabled: false,
    website: "https://ollama.com", apiFormat: "openai", headers: {}, options: {},
    models: [
      { id: "llama3.1", name: "Llama 3.1", enabled: true },
      { id: "qwen2.5", name: "Qwen 2.5", enabled: true },
    ],
  },
];

export async function loadProviders(): Promise<Provider[]> {
  if (typeof window === "undefined") return defaultProviders;
  try {
    const data = localStorage.getItem("providers_v2");
    if (data) {
      const parsed = migrateProviders(JSON.parse(data) as Array<Record<string, unknown>>);
      return await decryptProviders(parsed);
    }
    const oldData = localStorage.getItem("providers");
    if (oldData) {
      const migrated = migrateProviders(JSON.parse(oldData) as Array<Record<string, unknown>>);
      const encrypted = await encryptProviders(migrated);
      localStorage.setItem("providers_v2", JSON.stringify(encrypted));
      return migrated;
    }
    return defaultProviders;
  } catch { return defaultProviders; }
}

export async function saveProviders(list: Provider[]) {
  const encrypted = await encryptProviders(list);
  localStorage.setItem("providers_v2", JSON.stringify(encrypted));

  try {
    const active = list.find((p) => p.enabled && p.models.some((m) => m.enabled));
    const defaultModel = active?.models.find((m) => m.enabled);
    if (active && defaultModel) {
      let apiKey = active.apiKey || "";
      let apiUrl = active.baseUrl || "";
      // localStorage 无 key 时，保留 config.json/env 已有的 apiKey/apiUrl，避免空串覆盖
      if (!apiKey || !apiUrl) {
        try {
          const fileConfig = await ConfigService.get();
          if (!apiKey && fileConfig.apiKeyFrom !== "none" && fileConfig.apiKey) apiKey = fileConfig.apiKey;
          if (!apiUrl && fileConfig.apiUrl) apiUrl = fileConfig.apiUrl;
        } catch { /* ignore */ }
      }
      await ConfigService.save({
        provider: active.id.startsWith("custom-") ? "custom" : active.id,
        model: defaultModel.id,
        apiKey,
        apiUrl,
      });
    }
  } catch { /* JSON 文件保存失败不影响主流程 */ }
}

export function loadSettings(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem("settings") || "{}") as Record<string, unknown> }
  catch { return {} }
}

export function saveSettings(s: Record<string, any>) {
  localStorage.setItem("settings", JSON.stringify(s))
}

export async function getActiveProvider(): Promise<{ provider: string; model: string; apiKey: string; apiUrl: string } | null> {
  const list = await loadProviders();
  for (const p of list) {
    if (p.enabled) {
      const def = p.models.find((m) => m.enabled);
      let apiKey = p.apiKey;
      let apiUrl = p.baseUrl;
      if (!apiKey) {
        try {
          const fileConfig = await ConfigService.get();
          if (fileConfig.apiKeyFrom !== "none" && fileConfig.apiKey) {
            apiKey = fileConfig.apiKey;
            apiUrl = apiUrl || fileConfig.apiUrl;
          }
        } catch { /* ignore */ }
      }
      if (def) return { provider: p.id.startsWith("custom-") ? "custom" : p.id, model: def.id, apiKey, apiUrl };
    }
  }
  return null;
}

export async function getProviderById(providerId: string): Promise<{ apiKey: string; apiUrl: string; headers: Record<string, string>; options: Record<string, any> } | null> {
  const list = await loadProviders();
  for (const p of list) {
    const pid = p.id.startsWith("custom-") ? "custom" : p.id;
    if (pid === providerId && p.enabled) {
      if (p.apiKey) {
        return { apiKey: p.apiKey, apiUrl: p.baseUrl, headers: p.headers, options: p.options };
      }
      try {
        const fileConfig = await ConfigService.get();
        // 兜底：localStorage 无 key 时从 config.json/env 读取（file/env 来源）
        if (fileConfig.apiKeyFrom !== "none" && fileConfig.apiKey) {
          return {
            apiKey: fileConfig.apiKey,
            apiUrl: p.baseUrl || fileConfig.apiUrl,
            headers: { ...(fileConfig.headers || {}), ...(p.headers || {}) },
            options: { ...(fileConfig.options || {}), ...(p.options || {}) },
          };
        }
      } catch { /* ignore */ }
      return { apiKey: "", apiUrl: p.baseUrl, headers: p.headers, options: p.options };
    }
  }
  return null;
}

// ── 多模态视觉桥模型解析 ────────────────────────────────
// 识图策略决策已迁移至 provider-model.ts（② 层唯一决策模块），
// 此处仅保留数据访问职责：loadProviders / getProviderById / saveProviders 等。
