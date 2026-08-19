/**
 * officecli_* 工具公共 helper
 * - fail-closed：office 能力缝无 provider 时返回结构化错误（不 crash、不假死）
 * - runOfficeCliJson：执行 + JSON 输出格式化 + 退出码归一化
 */

import * as path from "path"
import type { ToolResult } from "../../shared/tool"
import { getOffice, type OfficeProvider, type OfficeRunOptions, type OfficeResult } from "../../capability/office"

export const OFFICECLI_NOT_FOUND = "officecli_not_found"

const INSTALL_GUIDE =
  "请安装 OfficeCLI：运行 `officecli install`，或从 https://github.com/iOfficeAI/OfficeCLI/releases 下载，或将二进制放入应用 resources/officecli/ 目录。"

/** 无 provider 时的结构化错误（fail-closed） */
export function officeNotFoundResult(): ToolResult {
  return {
    success: false,
    error: `OfficeCLI 未安装，officecli_* 工具不可用。${INSTALL_GUIDE}`,
    metadata: { code: OFFICECLI_NOT_FOUND },
  }
}

/**
 * 获取 office provider；不可用时返回错误结果（不抛异常）。
 * 返回类型区分：可用 → { office, error: null }；不可用 → { office: null, error }
 */
export function requireOffice():
  | { office: OfficeProvider; error: null }
  | { office: null; error: ToolResult } {
  const office = getOffice()
  if (!office || !office.isAvailable()) return { office: null, error: officeNotFoundResult() }
  return { office, error: null }
}

/** 相对工作区路径解析为绝对路径 */
export function resolveOfficePath(p: string, workspace: string): string {
  return path.isAbsolute(p) ? p : path.resolve(workspace, p)
}

/** 归一化 officecli 命令执行结果 */
export async function runOfficeCli(
  office: OfficeProvider,
  args: string[],
  options?: OfficeRunOptions,
): Promise<ToolResult> {
  const r = await office.run(args, options)
  if (r.timedOut) {
    return { success: false, error: `officecli 命令超时: ${args[0] ?? ""}`, metadata: { code: "officecli_timeout" } }
  }
  if (r.exitCode !== 0) {
    return {
      success: false,
      error: (r.stderr || r.stdout || "(no output)").slice(0, 5000),
      metadata: { exitCode: r.exitCode, code: "officecli_command_failed" },
    }
  }
  return {
    success: true,
    output: (r.stdout || "(no output)").slice(0, 10000),
    metadata: { exitCode: r.exitCode },
  }
}

/** 尝试将 stdout 解析为 JSON；成功则格式化输出（AI 友好），失败保持原文 */
export function formatJsonOutput(r: OfficeResult): string {
  const text = r.stdout || "(no output)"
  const trimmed = text.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return text
    }
  }
  return text
}