/**
 * LSP 工具 — 让 Agent 通过 LSP 协议理解代码
 * 类似 OpenCode 的 lsp.ts 工具
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { lspManager, type LSPServerManager } from "../../lsp/manager"
import type { ToolContext } from "../../shared/tool"
import * as path from "path"

/** LSP 管理器解析：优先 ctx.agentCtx.get("lsp") 服务（可替换），无 ctx 回退模块级单例 */
function resolveLSP(ctx: ToolContext): LSPServerManager {
  const svc = ctx.agentCtx?.get("lsp") as { getManager(): LSPServerManager } | undefined
  return svc?.getManager() ?? lspManager
}

export const lspDefinitionTool = make({
  name: "lsp_definition",
  description: "跳转到符号定义处。输入文件路径和行列位置，返回定义所在的文件、行、列。",
  inputSchema: z.object({
    path: z.string().describe("文件路径（相对 workspace）"),
    line: z.number().describe("行号（从 0 开始）"),
    column: z.number().describe("列号（从 0 开始）"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    try {
      const manager = resolveLSP(ctx)
      const locations = await manager.getDefinition(ctx.workspace, input.path, input.line, input.column)
      if (locations.length === 0) return { success: true, output: "未找到定义" }
      return {
        success: true,
        output: locations
          .map((loc) => {
            const relPath = path.relative(ctx.workspace, loc.uri.replace(/^file:\/\//, ""))
            return `${relPath}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
          })
          .join("\n"),
      }
    } catch (e) {
      return { success: false, error: `LSP 查询失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

export const lspReferencesTool = make({
  name: "lsp_references",
  description: "查找符号的所有引用位置。输入文件路径和行列位置，返回所有引用的文件:行:列。",
  inputSchema: z.object({
    path: z.string().describe("文件路径（相对 workspace）"),
    line: z.number().describe("行号（从 0 开始）"),
    column: z.number().describe("列号（从 0 开始）"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    try {
      const manager = resolveLSP(ctx)
      const refs = await manager.getReferences(ctx.workspace, input.path, input.line, input.column)
      if (refs.length === 0) return { success: true, output: "未找到引用" }
      return {
        success: true,
        output: refs
          .slice(0, 50)
          .map((ref) => {
            const relPath = path.relative(ctx.workspace, ref.uri.replace(/^file:\/\//, ""))
            return `${relPath}:${ref.range.start.line + 1}:${ref.range.start.character + 1}`
          })
          .join("\n") + (refs.length > 50 ? `\n... (共 ${refs.length} 处引用，显示前 50 处)` : ""),
      }
    } catch (e) {
      return { success: false, error: `LSP 查询失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

export const lspHoverTool = make({
  name: "lsp_hover",
  description: "获取符号的类型信息和文档。输入文件路径和行列位置，返回类型定义和文档字符串。",
  inputSchema: z.object({
    path: z.string().describe("文件路径（相对 workspace）"),
    line: z.number().describe("行号（从 0 开始）"),
    column: z.number().describe("列号（从 0 开始）"),
  }),
  outputSchema: z.string(),
  permission: "read",
  async execute(input, ctx) {
    try {
      const manager = resolveLSP(ctx)
      const info = await manager.getHoverInfo(ctx.workspace, input.path, input.line, input.column)
      if (!info) return { success: true, output: "该位置无类型信息" }
      return { success: true, output: info.contents }
    } catch (e) {
      return { success: false, error: `LSP 查询失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

/** 符号 Kind 名称映射（LSP SymbolKind 1~26） */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null", 22: "enumMember",
  23: "struct", 24: "event", 25: "operator", 26: "typeParameter",
}

/** 递归展开符号大纲为缩进文本 */
interface SymbolNode {
  name: string
  kind?: number
  children?: SymbolNode[]
}
function formatSymbolTree(symbols: SymbolNode[], depth = 0): string {
  const lines: string[] = []
  for (const sym of symbols) {
    const kindName = sym.kind !== undefined ? (SYMBOL_KIND_NAMES[sym.kind] ?? `kind${sym.kind}`) : "symbol"
    lines.push(`${"  ".repeat(depth)}${kindName} ${sym.name}`)
    if (sym.children?.length) lines.push(formatSymbolTree(sym.children, depth + 1))
  }
  return lines.join("\n")
}

export const lspSymbolsTool = make({
  name: "lsp_symbols",
  description: "获取文件的符号大纲（类、函数、方法、变量等层级结构）。输入文件路径，返回该文件所有符号及其类型。",
  inputSchema: z.object({
    path: z.string().describe("文件路径（相对 workspace）"),
  }),
  outputSchema: z.string(),
  permission: "read",
  isReadOnly: true,
  category: "infrastructure",
  async execute(input, ctx) {
    try {
      const manager = resolveLSP(ctx)
      const symbols = await manager.getSymbols(ctx.workspace, input.path)
      if (symbols.length === 0) return { success: true, output: "未找到符号（文件可能无符号或 LSP 未就绪）" }
      return {
        success: true,
        output: `文件符号大纲:\n${formatSymbolTree(symbols)}`,
      }
    } catch (e) {
      return { success: false, error: `LSP 查询失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

export const lspImplementationsTool = make({
  name: "lsp_implementations",
  description: "查找接口/抽象方法的实现位置。输入文件路径和行列位置，返回所有实现所在的文件:行:列。",
  inputSchema: z.object({
    path: z.string().describe("文件路径（相对 workspace）"),
    line: z.number().describe("行号（从 0 开始）"),
    column: z.number().describe("列号（从 0 开始）"),
  }),
  outputSchema: z.string(),
  permission: "read",
  isReadOnly: true,
  category: "infrastructure",
  async execute(input, ctx) {
    try {
      const manager = resolveLSP(ctx)
      const locs = await manager.getImplementations(ctx.workspace, input.path, input.line, input.column)
      if (locs.length === 0) return { success: true, output: "未找到实现" }
      return {
        success: true,
        output: locs
          .slice(0, 50)
          .map((loc) => {
            const relPath = path.relative(ctx.workspace, loc.uri.replace(/^file:\/\//, ""))
            return `${relPath}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
          })
          .join("\n") + (locs.length > 50 ? `\n... (共 ${locs.length} 处实现，显示前 50 处)` : ""),
      }
    } catch (e) {
      return { success: false, error: `LSP 查询失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

export const lspRenameTool = make({
  name: "lsp_rename",
  description: "跨文件重命名符号（函数/类/变量/接口等），自动更新所有引用位置。输入文件路径和符号位置及新名称，返回修改的文件和替换数。会先校验符号可重命名。",
  inputSchema: z.object({
    path: z.string().describe("文件路径（相对 workspace），包含待重命名的符号"),
    line: z.number().describe("行号（从 0 开始）"),
    column: z.number().describe("列号（从 0 开始）"),
    newName: z.string().describe("符号的新名称"),
  }),
  outputSchema: z.string(),
  permission: "edit",
  category: "infrastructure",
  async execute(input, ctx) {
    try {
      const manager = resolveLSP(ctx)
      const result = await manager.renameSymbol(ctx.workspace, input.path, input.line, input.column, input.newName)
      if (!result.success) return { success: false, error: result.error || "重命名失败" }
      return {
        success: true,
        output: `重命名成功: 修改 ${result.fileCount} 个文件，共 ${result.editCount} 处引用`,
      }
    } catch (e) {
      return { success: false, error: `LSP 重命名失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})

