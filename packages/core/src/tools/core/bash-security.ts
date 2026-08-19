// Danger levels determine which gates a command passes through
export type DangerLevel = "safe" | "requires_approval" | "blocked"

export interface CommandCheck {
  level: DangerLevel
  reason?: string
}

const SAFE_WRAPPERS = ["timeout", "nohup", "nice", "stdbuf", "chrt", "ionice"]

const SAFE_ENV_PREFIXES = [
  "NODE_ENV=", "PYTHONUNBUFFERED=", "TERM=", "TZ=",
  "HOME=", "PATH=", "LANG=", "LC_ALL=",
  "npm_config_", "CI=", "GIT_",
]

function stripSafeWrappers(cmd: string): string {
  let stripped = cmd.trim()
  for (const wrapper of SAFE_WRAPPERS) {
    const regex = new RegExp(`^${wrapper}\\s+`)
    while (stripped.match(regex)) {
      stripped = stripped.replace(regex, "")
    }
  }
  return stripped.trim()
}

function stripEnvVars(cmd: string): string {
  let stripped = cmd.trim()
  for (const prefix of SAFE_ENV_PREFIXES) {
    const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\S+\\s+`)
    while (stripped.match(regex)) {
      stripped = stripped.replace(regex, "")
    }
  }
  const genericEnvRegex = /^[A-Z_][A-Z0-9_]*=\S+\s+/
  while (stripped.match(genericEnvRegex)) {
    stripped = stripped.replace(genericEnvRegex, "")
  }
  return stripped.trim()
}

export function normalizeCommand(cmd: string): string {
  return stripEnvVars(stripSafeWrappers(cmd))
}

// Split composite commands (&&, ||, ;, |) into sub-commands
export function splitSubCommands(cmd: string): string[] {
  const parts: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let inDollarParen = 0
  let depth = 0
  let i = 0

  while (i < cmd.length) {
    const ch = cmd[i]
    const next = cmd[i + 1] || ""

    if (ch === "'" && !inDouble && inDollarParen === 0) { inSingle = !inSingle; current += ch; i++; continue }
    if (ch === '"' && !inSingle && inDollarParen === 0) { inDouble = !inDouble; current += ch; i++; continue }
    if (ch === "$" && next === "(") { inDollarParen++; current += ch; i++; continue }
    if (ch === ")" && inDollarParen > 0) { inDollarParen--; current += ch; i++; continue }
    if (ch === "(" && !inSingle && !inDouble && inDollarParen === 0) { depth++; current += ch; i++; continue }
    if (ch === ")" && !inSingle && !inDouble && inDollarParen === 0 && depth > 0) { depth--; current += ch; i++; continue }

    if (!inSingle && !inDouble && inDollarParen === 0 && depth === 0) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|") || ch === ";" || (ch === "|" && next !== "|")) {
        const trimmed = current.trim()
        if (trimmed) parts.push(trimmed)
        current = ""
        i += ch === ";" ? 1 : 2
        continue
      }
    }
    current += ch
    i++
  }

  const trimmed = current.trim()
  if (trimmed) parts.push(trimmed)

  return parts.length > 0 ? parts : [cmd.trim()]
}

// Determine if a command is read-only (no side effects)
const READONLY_COMMANDS = new Set([
  "cat", "ls", "find", "grep", "wc", "head", "tail", "less", "more",
  "pwd", "which", "type", "echo", "printf", "whoami", "id", "uname",
  "date", "cal", "df", "du", "env", "printenv", "getconf",
  "git status", "git diff", "git log", "git show", "git branch",
  "npm view", "npm search", "npm list",
  "node --version", "npm --version", "npx --version",
  "pip show", "pip list", "pip freeze",
  "cargo check", "rustc --version",
  "tsc --noEmit", "eslint",
])

const READONLY_PREFIXES = [
  "git log", "git diff", "git show", "git branch", "git status",
  "npm view", "npm search", "npm list",
  "pip show", "pip list",
]

export function isReadOnlyCommand(cmd: string): boolean {
  const normalized = normalizeCommand(cmd).toLowerCase().trim()
  if (READONLY_COMMANDS.has(normalized)) return true
  for (const prefix of READONLY_PREFIXES) {
    if (normalized.startsWith(prefix)) return true
  }
  if (/^git (log|diff|show|branch|status|help)\b/.test(normalized)) return true
  if (/^(ls|cat|find|grep|wc)\b/.test(normalized)) return true
  return false
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string; level: "blocked" | "requires_approval" }> = [
  // Destructive system operations
  { pattern: /\brm\s+(-rf|--recursive)\s+\/\s*(\b|$)/, reason: "Recursive root delete", level: "blocked" },
  { pattern: /\brm\s+(-rf|--recursive)\s+\/\*\s*(\b|$)/, reason: "Recursive root content delete", level: "blocked" },
  { pattern: /\bshutdown\b/, reason: "System shutdown", level: "blocked" },
  { pattern: /\breboot\b/, reason: "System reboot", level: "blocked" },
  { pattern: /\bpoweroff\b/, reason: "System poweroff", level: "blocked" },
  { pattern: /\bmkfs\b/, reason: "Filesystem format", level: "blocked" },
  { pattern: /\bdd\s+if=/, reason: "Direct disk write", level: "blocked" },
  { pattern: /\bchmod\s+-R\s+000\s+\//, reason: "Remove all permissions", level: "blocked" },
  { pattern: /\bmv\s+\/\*?\s*\/dev\/null/, reason: "Move files to null", level: "blocked" },
  { pattern: /:\(\)\s*\{[^}]*:\|:&\s*\;?\}\s*;/, reason: "Fork bomb", level: "blocked" },
  { pattern: /\b>\s*\/dev\/sd/, reason: "Direct disk write", level: "blocked" },

  // Dangerous command patterns
  { pattern: /\bsudo\b/, reason: "Sudo command requires approval", level: "requires_approval" },
  { pattern: /\bchown\b/, reason: "Change ownership", level: "requires_approval" },
  { pattern: /\bchmod\b/, reason: "Change permissions", level: "requires_approval" },
  { pattern: /\bpasswd\b/, reason: "Change password", level: "requires_approval" },
  { pattern: /\buser(add|del|mod)\b/, reason: "User management", level: "requires_approval" },
  { pattern: /\bgroup(add|del|mod)\b/, reason: "Group management", level: "requires_approval" },
  { pattern: /\bkillall?\b/, reason: "Process termination", level: "requires_approval" },
  { pattern: /\bpkill\b/, reason: "Process termination", level: "requires_approval" },
  { pattern: /\bmount\b/, reason: "Filesystem mount", level: "requires_approval" },
  { pattern: /\bumount\b/, reason: "Filesystem unmount", level: "requires_approval" },
  { pattern: /\bwget\s+.+-O\s+/i, reason: "Remote file download with output", level: "requires_approval" },
  { pattern: /\bcurl\s+.+-o\s+/i, reason: "Remote file download with output", level: "requires_approval" },
  { pattern: /\b(apt-get|apt|yum|dnf|pacman|brew)\s+install\b/, reason: "Package installation", level: "requires_approval" },
  { pattern: /\bnpm\s+(install|i|add|publish)\b/, reason: "npm package operation", level: "requires_approval" },
  { pattern: /\bpip\s+(install|uninstall)\b/, reason: "pip package operation", level: "requires_approval" },

  // Network operations
  { pattern: /\b(iptables|ufw|firewall)\b/, reason: "Firewall modification", level: "requires_approval" },
  { pattern: /\b(sshd|systemctl|service)\s+(restart|stop|start)\b/, reason: "Service management", level: "requires_approval" },
]

const PROTECTED_PATHS = [
  /^\/etc\//, /^\/usr\/(local\/)?bin\//,
  /\/\.git\//, /\/\.ssh\//, /\/\.config\//,
  /\/node_modules\//, /\/\.env$/,
]

function checkPathSafety(arg: string): CommandCheck | null {
  for (const pattern of PROTECTED_PATHS) {
    if (pattern.test(arg)) {
      return { level: "requires_approval", reason: `Protected path: ${arg}` }
    }
  }
  return null
}

const PATH_BEARING_COMMANDS = new Set([
  "rm", "mv", "cp", "chmod", "chown", "ln", "mkdir", "touch",
  "write_file", "edit_file",
])

function extractPathArgs(cmd: string): string[] {
  const paths: string[] = []
  const tokens = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  for (const token of tokens) {
    const value = token.replace(/^(["'])(.*)\1$/, "$2")
    if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~")) {
      paths.push(value)
    }
  }
  return paths
}

export function checkDangerousOutputRedirect(cmd: string): CommandCheck | null {
  const redirectMatch = cmd.match(/[>|]\s*(\/[^\s;|&]+)/)
  if (redirectMatch) {
    const target = redirectMatch[1]
    if (/^\/(etc|dev|proc|sys|boot)\//.test(target)) {
      return { level: "blocked", reason: `Output redirect to system path: ${target}` }
    }
  }
  return null
}

export function checkCommand(cmd: string): CommandCheck {
  const subCommands = splitSubCommands(cmd)

  for (const sub of subCommands) {
    const normalized = normalizeCommand(sub)
    if (!normalized) continue

    // Check dangerous patterns
    for (const dp of DANGEROUS_PATTERNS) {
      if (dp.pattern.test(normalized)) {
        return { level: dp.level, reason: dp.reason }
      }
    }

    // Check output redirect to system paths
    const redirectCheck = checkDangerousOutputRedirect(normalized)
    if (redirectCheck) return redirectCheck

    // Check path args for protected paths
    const commandName = normalized.split(/\s+/)[0]
    if (PATH_BEARING_COMMANDS.has(commandName)) {
      const paths = extractPathArgs(normalized)
      for (const p of paths) {
        const pathCheck = checkPathSafety(p)
        if (pathCheck) return pathCheck
      }
    }
  }

  return { level: isReadOnlyCommand(cmd) ? "safe" : "requires_approval" }
}
