import type { ToolCall } from "../../shared/tool"
import type { PermissionSet, PermissionRule } from "./index"
import { checkHardDeny } from "./index"
import type { ToolRegistry } from "../registry"

export interface PermissionRequest {
  id: string
  action: string
  resources: string[]
  toolCall: ToolCall
}

let idCounter = 0

export function generateId(): string {
  return `perm-${Date.now().toString(36)}-${++idCounter}`
}

export function extractResources(args: Record<string, unknown>): string[] {
  const resources: string[] = []
  const keys = ["path", "file", "url", "command", "dir", "directory"]
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string") resources.push(value)
  }
  return resources
}

/** 从工具调用参数中提取 resource 字符串数组（用于命令级权限匹配） */
export function extractActionResources(toolName: string, args: Record<string, unknown>): string[] {
  const resources: string[] = []

  // 文件类工具：path / file_path / directory / dir
  if (["read_file", "write_file", "edit_file", "list_files", "apply_patch", "delete_file", "move_file"].includes(toolName)) {
    for (const key of ["path", "file_path", "directory", "dir", "oldPath", "newPath"]) {
      const value = args[key]
      if (typeof value === "string" && value.length > 0) resources.push(value)
    }
  }

  // bash：command
  if (toolName === "bash" && typeof args.command === "string" && args.command.length > 0) {
    resources.push(args.command)
  }

  // 搜索类：pattern / query / glob
  if (["glob", "grep", "code_search"].includes(toolName) && typeof args.pattern === "string") {
    resources.push(args.pattern)
  }
  if (toolName === "grep" && typeof args.path === "string") resources.push(args.path)

  // 网络类：url / query
  if (["web_fetch", "web_browse"].includes(toolName) && typeof args.url === "string") {
    resources.push(args.url)
  }
  if (toolName === "web_search" && typeof args.query === "string") resources.push(args.query)

  return resources
}

/** 从工具调用参数中提取 resource 字符串（单一资源，向后兼容） */
export function extractActionResource(toolName: string, args: Record<string, unknown>): string | undefined {
  const resources = extractActionResources(toolName, args)
  return resources[0]
}

export interface ApprovalResult {
  toolCall: ToolCall
  args: Record<string, unknown>
  permissionAction: string
  needsApproval: boolean
  hardDenied?: string
  /** 规则级 deny 原因（命中 `effect: "deny"` 规则） */
  denyReason?: string
}

export function evaluateToolCalls(
  toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
  registry: ToolRegistry,
  permissions?: PermissionSet,
): ApprovalResult[] {
  return toolCalls.map((call) => {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(call.function.arguments) } catch { /* JSON 解析失败时使用空对象兜底 */ }
    const def = registry.get(call.function.name)
    const permissionAction = def?.permission || call.function.name
    const resources = extractActionResources(call.function.name, args)

    // Gate 1: hard deny — 直接拒绝，不弹窗
    if (call.function.name === "bash" && typeof args.command === "string") {
      const hardDenied = checkHardDeny(args.command)
      if (hardDenied) {
        return {
          toolCall: { id: call.id, name: call.function.name, input: args },
          args,
          permissionAction,
          needsApproval: false,
          hardDenied,
        }
      }
    }

    // Gate 2+3: rule matching + user approval
    const ruleEffect = permissions?.evaluateResources(permissionAction, resources) ?? "allow"
    const needsApproval = ruleEffect === "ask"
    const denyReason = ruleEffect === "deny" ? `blocked by rule: ${permissionAction} denies this action` : undefined

    return {
      toolCall: { id: call.id, name: call.function.name, input: args },
      args,
      permissionAction,
      needsApproval,
      denyReason,
    }
  })
}
