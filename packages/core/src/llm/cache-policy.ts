import type { CachePolicy } from "./schema/options"

/**
 * 解析缓存策略，决定是否启用 Prompt 缓存
 *
 * Anthropic 需要显式注入 cache_control marker；
 * OpenAI 及其兼容协议（DeepSeek 等）服务端自动缓存，无需注入。
 */
export function shouldCache(policy: CachePolicy | undefined, provider: string): boolean {
  if (!policy || policy === "none") return false
  if (policy === "auto") return ["anthropic", "openai", "deepseek", "groq", "fireworks", "together"].includes(provider)
  return true
}

/**
 * 为 Anthropic 风格的 system 内容追加 cache_control 断点
 */
export function withSystemCache(system: string | undefined, policy: CachePolicy | undefined, provider: string): unknown {
  if (!system) return undefined
  if (!shouldCache(policy, provider) || provider !== "anthropic") return system

  // Anthropic system 支持 string 或 block 数组，block 可携带 cache_control
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
}

/**
 * 为 Anthropic 风格的 tools 数组追加 cache_control 断点
 */
export function withToolsCache(
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  policy: CachePolicy | undefined,
  provider: string,
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined
  const cacheable = shouldCache(policy, provider) && provider === "anthropic"

  // 对齐 opencode：只给最后一个 tool 打断点，收敛为三锚点（system + 最后 tool + 最新 user）
  if (!cacheable) {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }
  const lastIdx = tools.length - 1
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
    ...(i === lastIdx ? { cache_control: { type: "ephemeral" } } : {}),
  }))
}

/**
 * 为 Anthropic 风格的最后一条 user 消息追加 cache_control 断点
 * 泛型 T 兼容不同序列化结果（Record 或强类型消息数组）
 */
export function withMessageCache<T extends Array<Record<string, any>>>(messages: T, policy: CachePolicy | undefined, provider: string): T {
  if (!shouldCache(policy, provider) || provider !== "anthropic") return messages
  if (messages.length === 0) return messages

  const msgs = messages.map((m) => ({ ...m }))
  const last = msgs[msgs.length - 1]

  // 只对文本/最终 user 消息追加缓存断点，避免对 tool_result 注入
  if (last.role === "user" && typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }]
  }
  return msgs as T
}

/** 兼容旧接口：返回缓存 marker 映射（保留导出避免破坏调用方） */
export function resolveCacheMarkers(policy: CachePolicy, provider: string): Record<string, unknown> {
  if (!shouldCache(policy, provider)) return {}

  if (typeof policy === "object") {
    const markers: Record<string, unknown> = {}
    if (policy.ttlSeconds && provider === "anthropic") {
      markers.ttl = policy.ttlSeconds
    }
    return markers
  }

  return {}
}
