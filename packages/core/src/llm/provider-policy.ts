/**
 * ProviderPolicyEngine — Provider 策略引擎
 * 控制是否允许使用某个 Provider，支持 Wildcard 规则匹配
 */

export interface ProviderRule {
  effect: "allow" | "deny"
  action: string       // "use" | "route" | "fallback"
  resource: string     // provider name 或 model name（支持通配符）
}

/** Wildcard 匹配 */
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

export class ProviderPolicyEngine {
  private rules: ProviderRule[] = []

  /** 加载策略规则 */
  load(rules: ProviderRule[]): void {
    this.rules = rules
  }

  /** 评估是否允许使用某个 Provider */
  evaluate(providerName: string, modelName?: string): "allow" | "deny" {
    // 从后往前遍历，最后一个匹配的规则生效（last-match-wins）
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]
      if (rule.action !== "use") continue

      // 匹配 provider name
      if (wildcardMatch(rule.resource, providerName)) {
        return rule.effect
      }

      // 匹配 model name（如果指定了）
      if (modelName && wildcardMatch(rule.resource, modelName)) {
        return rule.effect
      }
    }

    // 默认允许
    return "allow"
  }

  /** 获取所有规则（用于 UI 展示） */
  getRules(): ProviderRule[] {
    return [...this.rules]
  }

  /** 导出规则为 JSON */
  exportRules(): string {
    return JSON.stringify(this.rules, null, 2)
  }

  /** 从 JSON 导入规则 */
  importRules(json: string): void {
    try {
      const rules = JSON.parse(json)
      if (!Array.isArray(rules)) return
      this.rules = rules.filter((r) => isValidRule(r))
    } catch { /* 静默 */ }
  }
}

/** 校验并收窄 JSON 中的规则为 ProviderRule */
function isValidRule(r: unknown): r is ProviderRule {
  if (!r || typeof r !== "object") return false
  const rule = r as Record<string, unknown>
  if (typeof rule.action !== "string" || typeof rule.resource !== "string") return false
  return rule.effect === "allow" || rule.effect === "deny"
}
