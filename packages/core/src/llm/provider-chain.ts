/**
 * ProviderChain — Provider Failover Chain
 * 根据模型自动选择最优 Provider，支持 failover
 */

import type { ProviderPolicyEngine } from "./provider-policy"

export interface ProviderChainConfig {
  providers: Array<{
    name: string
    priority: number        // 数字越小优先级越高
    models?: string[]       // 支持的模型（可选，空表示支持所有）
    maxRetries?: number
  }>
}

export class ProviderChain {
  private providers: ProviderChainConfig["providers"]
  private policy: ProviderPolicyEngine

  constructor(config: ProviderChainConfig, policy: ProviderPolicyEngine) {
    // 按 priority 排序
    this.providers = [...config.providers].sort((a, b) => a.priority - b.priority)
    this.policy = policy
  }

  /**
   * 根据模型选择最优 Provider
   * @param modelName 模型名称
   * @returns 最优 Provider 名称，或 null（无可用 Provider）
   */
  selectProvider(modelName: string): string | null {
    for (const provider of this.providers) {
      // 检查策略是否允许
      if (this.policy.evaluate(provider.name, modelName) === "deny") {
        continue
      }

      // 检查模型是否匹配
      if (provider.models && provider.models.length > 0) {
        const modelMatch = provider.models.some(m =>
          m === modelName || wildcardMatch(m, modelName)
        )
        if (!modelMatch) continue
      }

      return provider.name
    }

    return null
  }

  /**
   * 获取 failover 链
   * @param modelName 模型名称
   * @returns 按优先级排序的 Provider 列表
   */
  getFailoverChain(modelName: string): string[] {
    return this.providers
      .filter(p => {
        // 检查策略
        if (this.policy.evaluate(p.name, modelName) === "deny") return false
        // 检查模型
        if (p.models && p.models.length > 0) {
          return p.models.some(m => m === modelName || wildcardMatch(m, modelName))
        }
        return true
      })
      .map(p => p.name)
  }

  /**
   * 添加 Provider 到链
   */
  addProvider(provider: ProviderChainConfig["providers"][0]): void {
    this.providers.push(provider)
    this.providers.sort((a, b) => a.priority - b.priority)
  }

  /**
   * 从链中移除 Provider
   */
  removeProvider(name: string): void {
    this.providers = this.providers.filter(p => p.name !== name)
  }

  /**
   * 获取所有 Provider
   */
  getAll(): ProviderChainConfig["providers"] {
    return [...this.providers]
  }
}

/** Wildcard 匹配（内部使用） */
function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern === value) return true
  if (!pattern.includes("*")) return pattern === value

  const literals = pattern.split("*").filter(p => p !== "")
  if (literals.length === 0) return true

  let vIdx = 0
  for (const lit of literals) {
    const found = value.indexOf(lit, vIdx)
    if (found === -1) return false
    vIdx = found + lit.length
  }
  if (!pattern.endsWith("*")) {
    return value.endsWith(literals[literals.length - 1])
  }
  return true
}
