export interface PermissionRule {
  action: string    // read / write / bash / web_search / *
  resource: string  // * / ** / src/** / npm * / rm -rf *
  effect: "allow" | "deny" | "ask"
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern === value) return true
  if (pattern.includes("**")) return doubleStarMatch(pattern, value)
  return singleStarMatch(pattern, value)
}

function singleStarMatch(pattern: string, value: string): boolean {
  const pSegments = pattern.split("/")
  const vSegments = value.split("/")
  if (pSegments.length !== vSegments.length) return false
  for (let i = 0; i < pSegments.length; i++) {
    if (!segmentMatch(pSegments[i], vSegments[i])) return false
  }
  return true
}

function doubleStarMatch(pattern: string, value: string): boolean {
  const pSegments = pattern.split("/")
  const vSegments = value.split("/")
  return matchSegments(pSegments, vSegments, 0, 0)
}

function matchSegments(pParts: string[], vParts: string[], pi: number, vi: number): boolean {
  while (pi < pParts.length) {
    if (pParts[pi] === "**") {
      pi++
      if (pi === pParts.length) return true
      for (let skip = 0; skip <= vParts.length - vi; skip++) {
        if (matchSegments(pParts, vParts, pi, vi + skip)) return true
      }
      return false
    }
    if (vi >= vParts.length) return false
    if (!segmentMatch(pParts[pi], vParts[vi])) return false
    pi++
    vi++
  }
  return vi === vParts.length
}

function segmentMatch(pattern: string, value: string): boolean {
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

/** 检测命令是否包含 shell 链式操作符 */
function hasShellChain(cmd: string): boolean {
  return /&&|\|\||;|\||\r\n|`|\$\(/.test(cmd)
}

/** 判断一个通配符匹配是否来自「前缀放行」规则（如 ls *），命中链式命令时不得放行 */
function chainableAllowLeaks(action: string, pattern: string, resources: string[]): boolean {
  if (action !== "bash") return false
  if (!pattern.includes("*")) return false
  if (pattern === "*" || pattern === "**") return false
  return resources.some((r) => hasShellChain(r))
}

/** Gate 1: 硬拒绝列表 — 任何匹配这些模式的 bash 命令直接拒绝 */
const HARD_DENY_PATTERNS = [
  "rm -rf /",
  "rm -rf /*",
  "sudo",
  "shutdown",
  "reboot",
  "mkfs",
  "dd if=",
  "> /dev/sd",
  ":(){ :|:& };:",  // fork bomb
  "chmod -R 000 /",
  "mv /* /dev/null",
]

export function checkHardDeny(command: string): string | null {
  for (const pattern of HARD_DENY_PATTERNS) {
    if (command.includes(pattern)) return `Blocked: '${pattern}' is on the deny list`
  }
  return null
}

export class PermissionSet {
  private rules: PermissionRule[]
  private matchCache = new Map<string, "allow" | "deny" | "ask">()

  constructor(rules: PermissionRule[] = []) {
    this.rules = rules
  }

  isAllowed(action: string, permission?: string): boolean {
    const result = this.evaluate(action, permission)
    return result === "allow" || result === "ask"
  }

  needsApproval(action: string, resource?: string | string[]): boolean {
    if (resource !== undefined) {
      const resList = Array.isArray(resource) ? resource : [resource]
      return this.evaluateResources(action, resList) === "ask"
    }
    return this.evaluate(action) === "ask"
  }

  /**
   * 评估权限（向后兼容版本）
   * 第二个参数是 permission alias（如工具定义中的 `permission` 字段）
   * 用于 registry.ts 的工具可见性过滤
   */
  evaluate(action: string, permission?: string): "allow" | "deny" | "ask" {
    const actionName = permission || action
    const cacheKey = actionName
    const cached = this.matchCache.get(cacheKey)
    if (cached !== undefined) return cached

    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]
      if (wildcardMatch(rule.action, actionName)) {
        this.matchCache.set(cacheKey, rule.effect)
        return rule.effect
      }
    }
    this.matchCache.set(cacheKey, "allow")
    return "allow"
  }

  /**
   * 命令级别权限评估（新）
   * 同时匹配 action（工具名）和 resource（命令/路径内容）
   * 支持 OpenCode 风格复合规则格式 `action:resource`（如 `edit:src/**`）
   * 用于 permission-gate.ts 的精确权限检查
   */
  evaluateResource(action: string, resource: string): "allow" | "deny" | "ask" {
    return this.evaluateResources(action, [resource])
  }

  /**
   * 精细化权限评估 — 多资源匹配
   * 规则优先级（last-match-wins）：
   * 1. 复合格式规则 `edit:src/**` — 要求 action + 任一资源都命中
   * 2. 传统规则 `{ action: "edit", resource: "src/**" }` — action 命中 + 任一资源命中
   */
  evaluateResources(action: string, resources: string[]): "allow" | "deny" | "ask" {
    const cacheKey = `${action}::${resources.join("|")}`
    const cached = this.matchCache.get(cacheKey)
    if (cached !== undefined) return cached

    const resList = resources.filter((r): r is string => typeof r === "string" && r.length > 0)

    let skippedChainableAllow = false

    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i]

      // 复合格式规则：`edit:src/**` — action 中冒号前的部分是工具名，冒号后是资源模式
      const colonIdx = rule.action.indexOf(":")
      if (colonIdx > 0) {
        const ruleAction = rule.action.slice(0, colonIdx)
        const ruleResource = rule.action.slice(colonIdx + 1)
        if (!wildcardMatch(ruleAction, action)) continue
        if (resList.length === 0) continue
        if (!resList.some(r => wildcardMatch(ruleResource, r))) continue
        // 链式命令保护：通配符前缀 allow 不得放行含 && / || / ; / | 的命令
        if (rule.effect === "allow" && chainableAllowLeaks(action, ruleResource, resList)) {
          skippedChainableAllow = true
          continue
        }
        this.matchCache.set(cacheKey, rule.effect)
        return rule.effect
      }

      // 传统格式规则
      if (!wildcardMatch(rule.action, action)) continue
      if (rule.resource !== "*" && !resList.some(r => wildcardMatch(rule.resource, r))) continue
      // 链式命令保护：通配符前缀 allow（如 ls *）不得放行链式命令
      if (rule.effect === "allow" && chainableAllowLeaks(action, rule.resource, resList)) {
        skippedChainableAllow = true
        continue
      }
      this.matchCache.set(cacheKey, rule.effect)
      return rule.effect
    }

    // 通配符前缀 allow 被跳过且无兜底规则时，链式命令应要求确认而非默认放行
    if (skippedChainableAllow) {
      this.matchCache.set(cacheKey, "ask")
      return "ask"
    }

    this.matchCache.set(cacheKey, "allow")
    return "allow"
  }

  /**
   * 清空匹配缓存（规则变更后调用）
   */
  invalidateCache(): void {
    this.matchCache.clear()
  }

  /**
   * 追加规则（精细化管理入口，追加后自动失效缓存）
   */
  addRule(rule: PermissionRule): void {
    this.rules.push(rule)
    this.invalidateCache()
  }

  /**
   * 移除规则（按 action+resource+effect 精确匹配）
   */
  removeRule(rule: PermissionRule): boolean {
    const before = this.rules.length
    this.rules = this.rules.filter(r =>
      !(r.action === rule.action && r.resource === rule.resource && r.effect === rule.effect)
    )
    if (this.rules.length !== before) {
      this.invalidateCache()
      return true
    }
    return false
  }

  getAll(): PermissionRule[] {
    return [...this.rules]
  }

  static fromConfig(config: Record<string, unknown>): PermissionSet {
    const rules: PermissionRule[] = []
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string" && ["allow", "deny", "ask"].includes(value)) {
        rules.push({ action: key, resource: "*", effect: value as PermissionRule["effect"] })
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [pattern, action] of Object.entries(value as Record<string, string>)) {
          if (["allow", "deny", "ask"].includes(action)) {
            rules.push({ action: key, resource: pattern, effect: action as PermissionRule["effect"] })
          }
        }
      }
    }
    return new PermissionSet(rules)
  }

  static merge(...rulesets: PermissionRule[][]): PermissionSet {
    return new PermissionSet(rulesets.flat())
  }

  /** 获取所有规则（用于 UI 展示） */
  getRules(): PermissionRule[] {
    return [...this.rules]
  }

  /** 导出规则为 JSON */
  exportRules(): string {
    return JSON.stringify(this.rules, null, 2)
  }

  /** 从 JSON 导入规则 */
  static importRules(json: string): PermissionSet {
    try {
      const parsed = JSON.parse(json) as unknown
      if (!Array.isArray(parsed)) return new PermissionSet([])
      const validRules = (parsed as Array<Record<string, unknown>>).filter((r) =>
        r && typeof r.action === "string" && typeof r.resource === "string" &&
        (r.effect === "allow" || r.effect === "deny" || r.effect === "ask")
      ) as unknown as PermissionRule[]
      return new PermissionSet(validRules)
    } catch {
      return new PermissionSet([])
    }
  }
}

const basePermissionRules: PermissionRule[] = [
  // 只读工具：直接允许（使用别名匹配）
  { action: "read", resource: "*", effect: "allow" },
  { action: "read_file", resource: "*", effect: "allow" },
  { action: "list_files", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "web_search", resource: "*", effect: "allow" },
  { action: "web_fetch", resource: "*", effect: "allow" },
  { action: "web_browse", resource: "*", effect: "allow" },
  // bash: 安全的命令自动允许
  { action: "bash", resource: "ls *", effect: "allow" },
  { action: "bash", resource: "cat *", effect: "allow" },
  { action: "bash", resource: "which *", effect: "allow" },
  { action: "bash", resource: "echo *", effect: "allow" },
  { action: "bash", resource: "pwd", effect: "allow" },
  { action: "bash", resource: "node --version", effect: "allow" },
  // bash: 其他需要确认
  { action: "bash", resource: "*", effect: "ask" },
  // 写操作：需要确认（使用别名匹配）
  { action: "edit", resource: "*", effect: "ask" },
  { action: "write_file", resource: "*", effect: "ask" },
  { action: "edit_file", resource: "*", effect: "ask" },
  { action: "run_code", resource: "*", effect: "ask" },
  { action: "code_exec", resource: "*", effect: "ask" },
]

export const defaultPermissions = new PermissionSet(basePermissionRules)

export function permissionsForMode(
  mode: string,
  modeRules: PermissionRule[],
): PermissionSet {
  const allRules = [...modeRules, ...basePermissionRules]
  return new PermissionSet(allRules)
}
