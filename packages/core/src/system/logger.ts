/**
 * 简单日志系统 — 工具调用审计 + 调试日志
 */

import { join } from "path"
import fs from "fs"
import { getPlatformPaths } from "../config/paths"

export interface ToolCallLog {
  timestamp: string
  toolName: string
  args: Record<string, unknown>
  result: { success: boolean; output?: string; error?: string }
  durationMs: number
  provider?: string
  model?: string
  tokens?: number
}

const MAX_LOG_ENTRIES = 1000
let logs: ToolCallLog[] = []

function getLogDir(): string {
  return join(getPlatformPaths().userData, "logs")
}

/** 记录一次工具调用 */
export function logToolCall(entry: ToolCallLog): void {
  logs.push(entry)
  if (logs.length > MAX_LOG_ENTRIES) {
    logs = logs.slice(-MAX_LOG_ENTRIES)
  }

  // 异步写入日志文件
  try {
    const dir = getLogDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const date = new Date().toISOString().slice(0, 10)
    const logPath = join(dir, `agent-${date}.log`)
    const line = `[${entry.timestamp}] TOOL ${entry.toolName} ${entry.durationMs}ms ` +
      `${entry.result.success ? "OK" : "FAIL"}` +
      (entry.provider ? ` (${entry.provider})` : "") +
      (entry.tokens ? ` [${entry.tokens}tokens]` : "") + "\n"
    fs.appendFileSync(logPath, line, "utf-8")
  } catch { /* 静默 */ }
}

/** 获取最近的工具调用日志 */
export function getRecentToolLogs(count = 50): ToolCallLog[] {
  return logs.slice(-count)
}

/** 获取今天日志文件的全部内容 */
export function getTodayLogContent(): string {
  try {
    const date = new Date().toISOString().slice(0, 10)
    const logPath = join(getLogDir(), `agent-${date}.log`)
    if (fs.existsSync(logPath)) {
      return fs.readFileSync(logPath, "utf-8")
    }
  } catch { /* 静默 */ }
  return "No logs for today."
}

/** 通用错误日志（带时间戳和上下文） */
export function logError(context: string, error?: unknown): void {
  const msg = error instanceof Error ? error.message : error ? String(error) : ""
  const line = `[${new Date().toISOString()}] [ERROR] ${context}${msg ? `: ${msg}` : ""}`
  try {
    const date = new Date().toISOString().slice(0, 10)
    const logDir = getLogDir()
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(join(logDir, `error-${date}.log`), line + "\n", "utf-8")
  } catch { /* 日志写入失败时静默 */ }
  console.error(line)
}

/** 通用信息日志（带时间戳，写入 agent 日志文件） */
export function logInfo(context: string, detail?: string): void {
  const line = `[${new Date().toISOString()}] [INFO] ${context}${detail ? `: ${detail}` : ""}`
  try {
    const date = new Date().toISOString().slice(0, 10)
    const logDir = getLogDir()
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(join(logDir, `agent-${date}.log`), line + "\n", "utf-8")
  } catch { /* 静默 */ }
  console.log(line)
}

/** 清空日志 */
export function clearLogs(): void {
  logs = []
}

