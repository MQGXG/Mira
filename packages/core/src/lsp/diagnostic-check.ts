/**
 * 编辑后诊断自检 — 对比编辑前后的 LSP 诊断，识别新增问题
 * 参考 Serena util/ls_diagnostics.py 的 DiagnosticsDiff（编辑前后快照对比新增诊断）
 */

import type { LSPDiagnostic } from "./client"

/** 归一化后的诊断问题（面向 Agent 展示） */
export interface DiagnosticIssue {
  /** 严重度 */
  severity: "error" | "warning" | "info" | "hint"
  /** 诊断消息 */
  message: string
  /** 诊断代码（如 TS2322） */
  code?: string | number
  /** 行号（1-based，展示友好） */
  line: number
  /** 列号（1-based） */
  column: number
}

/** 编辑后诊断检查结果 */
export interface DiagnosticCheckResult {
  /** 检查是否执行（LSP 可用且完成了诊断刷新） */
  checked: boolean
  /** 是否存在编辑前基线（无可比基线时仅报告当前诊断） */
  baselineAvailable: boolean
  /** 新增的错误级诊断 */
  newErrors: DiagnosticIssue[]
  /** 新增的警告级诊断 */
  newWarnings: DiagnosticIssue[]
  /** 检查耗时（毫秒） */
  elapsedMs: number
}

/** LSP 诊断严重度数值 → 名称映射（1=Error, 2=Warning, 3=Information, 4=Hint） */
function severityName(severity?: number): DiagnosticIssue["severity"] {
  switch (severity) {
    case 1: return "error"
    case 2: return "warning"
    case 3: return "info"
    case 4: return "hint"
    default: return "info"
  }
}

/** 诊断身份键：以消息+代码为准（位置可能随插入行漂移，内容稳定） */
function diagnosticIdentity(d: LSPDiagnostic): string {
  return `${d.message}|${String(d.code ?? "")}`
}

/** 将 LSP 诊断归一化为展示用问题 */
function toIssue(d: LSPDiagnostic): DiagnosticIssue {
  return {
    severity: severityName(d.severity),
    message: d.message,
    code: d.code,
    line: (d.range?.start?.line ?? 0) + 1,
    column: (d.range?.start?.character ?? 0) + 1,
  }
}

/**
 * 对比编辑前后诊断，返回新增的问题
 * 以"消息+代码"为身份键，剔除编辑前已存在的诊断
 */
export function diffDiagnostics(before: LSPDiagnostic[], after: LSPDiagnostic[]): {
  newErrors: DiagnosticIssue[]
  newWarnings: DiagnosticIssue[]
} {
  const beforeKeys = new Set(before.map(diagnosticIdentity))
  const newErrors: DiagnosticIssue[] = []
  const newWarnings: DiagnosticIssue[] = []

  for (const d of after) {
    if (beforeKeys.has(diagnosticIdentity(d))) continue
    const issue = toIssue(d)
    if (issue.severity === "error") newErrors.push(issue)
    else if (issue.severity === "warning") newWarnings.push(issue)
  }

  return { newErrors, newWarnings }
}

/**
 * 将检查结果格式化为面向 Agent 的文本摘要
 * @returns 空字符串表示无新增问题
 */
export function formatDiagnosticCheck(result: DiagnosticCheckResult): string {
  if (!result.checked) return ""

  const parts: string[] = []
  if (result.newErrors.length > 0) {
    parts.push(`编辑后新增 ${result.newErrors.length} 个错误:`)
    for (const err of result.newErrors.slice(0, 10)) {
      parts.push(`  [${err.severity}] ${err.message}${err.code ? ` (${err.code})` : ""} @ line ${err.line}:${err.column}`)
    }
    if (result.newErrors.length > 10) parts.push(`  ... 其余 ${result.newErrors.length - 10} 个错误略`)
  }
  if (result.newWarnings.length > 0) {
    parts.push(`编辑后新增 ${result.newWarnings.length} 个警告:`)
    for (const warn of result.newWarnings.slice(0, 10)) {
      parts.push(`  [${warn.severity}] ${warn.message}${warn.code ? ` (${warn.code})` : ""} @ line ${warn.line}:${warn.column}`)
    }
  }
  if (parts.length === 0) {
    return result.baselineAvailable
      ? "编辑后诊断检查通过：无新增错误或警告。"
      : ""
  }
  return parts.join("\n")
}
