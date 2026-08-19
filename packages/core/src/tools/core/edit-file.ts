/**
 * Edit File 工具 — 增强版，参考 OpenCode 的 9 种匹配策略
 */

import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"
import { make, type Content } from "../../shared/tool"
import { getSnapshotManager } from "../../session/snapshot"
import { realPath, contains } from "./path-util"
import { invalidateFileState, isFileChanged } from "./file-state-cache"
import { normalizeEditInput } from "./escape-util"
import { lspManager } from "../../lsp/manager"
import { pathToFileURL } from "url"
import { replace, limitDiffLines } from "./edit-matchers"
import { extractSymbolName, findSymbolInTree, detectLanguage } from "./edit-symbol"
import { createTwoFilesPatch } from "diff"

const writeLocks = new Map<string, Promise<void>>()

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(filePath) || Promise.resolve()
  const next = prev.then(fn, fn)
  writeLocks.set(filePath, next.then(() => {}, () => {}))
  return next
}

function previewLines(value: string, prefix: string): string[] {
  const lines = value.split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

const BOM = "\uFEFF"
function stripBom(text: string): { bom: boolean; text: string } {
  return text.startsWith(BOM) ? { bom: true, text: text.slice(1) } : { bom: false, text }
}
function joinBom(text: string, bom: boolean): string {
  return bom ? `${BOM}${text}` : text
}

const normalizeLineEndings = (s: string) => s.replace(/\r\n/g, "\n")
const detectLineEnding = (s: string): "\n" | "\r\n" => s.includes("\r\n") ? "\r\n" : "\n"
const convertToLineEnding = (s: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(s) : normalizeLineEndings(s).split("\n").join("\r\n")

function countOccurrences(content: string, search: string): number {
  if (search === "") return 0
  let count = 0, offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) { count++; offset += search.length }
  return count
}

export const editFileTool = make({
  name: "edit_file",
  description: "Replace specific text in an existing file. Uses fuzzy matching with 9 strategies. ALWAYS read the file first before editing. Use when: fixing bugs in code, updating specific lines, changing function implementations, modifying config values.",
  inputSchema: z.object({
    path: z.string().describe("File path to edit (absolute or relative to workspace)"),
    oldString: z.string().describe("Exact text to replace"),
    newString: z.string().describe("Replacement text, must differ from oldString"),
    replaceAll: z.boolean().optional().default(false).describe("Replace all occurrences (default false)"),
  }),
  outputSchema: z.string(),
  permission: "edit",
  toModelOutput(input, output): Content[] {
    const outputStr = typeof output === "string" ? output : ""
    const match = outputStr.match(/(\d+) replacement/)
    const count = match ? match[1] : "?"
    const diff = [
      `Edited file successfully. Replacements: ${count}`,
      "```diff",
      ...previewLines(input.oldString, "-"),
      ...previewLines(input.newString, "+"),
      "```",
    ].join("\n")
    return [{ type: "text", text: diff }]
  },

  async execute(input, ctx) {
    const isAbsolute = path.isAbsolute(input.path)
    const absolute = isAbsolute ? input.path : path.resolve(ctx.workspace, input.path)
    const real = await realPath(absolute)
    const root = await realPath(ctx.workspace)
    if (!isAbsolute && !contains(root, real)) {
      return { success: false, error: `相对路径逃逸工作区: ${input.path}` }
    }

    if (input.oldString === input.newString) {
      return { success: false, error: "No changes to apply: oldString and newString are identical." }
    }
    if (input.oldString === "") {
      return { success: false, error: "oldString must not be empty. Use write_file to create files." }
    }

    // 反转义 LLM 输出的特殊标记
    const { oldString: cleanOld, newString: cleanNew } = normalizeEditInput(input.oldString, input.newString)

    // 快照：编辑前捕获文件状态
    const snapshotMgr = getSnapshotManager(ctx.workspace)
    const snapshotId = await snapshotMgr.capture([real], `edit_file: ${input.path}`)

    let originalBytes: Buffer
    try {
      originalBytes = await fs.readFile(real)
    } catch (e: unknown) {
      return { success: false, error: `Cannot read ${input.path}: ${e}` }
    }

    const { bom, text: sourceText } = stripBom(originalBytes.toString("utf-8"))
    const ending = detectLineEnding(sourceText)
    const oldString = convertToLineEnding(cleanOld, ending)
    const newString = convertToLineEnding(cleanNew, ending)

    let replaced: string
    let usedOldString = oldString
    try {
      replaced = replace(sourceText, oldString, newString, input.replaceAll)
    } catch (e: any) {
      // 9 种策略全部失败 → LSP 增强回退：通过符号名定位代码块
      const lspResult = await tryLspEnhancedEdit(real, oldString, newString, sourceText, ctx.workspace)
      if (lspResult) {
        replaced = lspResult.replaced
        usedOldString = lspResult.usedOldString
      } else {
        return { success: false, error: e.message + "\n\n💡 提示: 尝试使用 apply_patch 或确认代码块与文件中完全一致（包括缩进和空格）。" }
      }
    }

    // 通过写入锁执行写入（含 stale 检测 + 文件写入）
    return withFileLock(real, async () => {
      // Stale 检测（双通道：mtime + 内容级）
      try {
        const stat = await fs.stat(real)
        if (isFileChanged(real, stat.mtimeMs)) {
          return { success: false, error: "File changed after read. Read it again before editing." }
        }
      } catch (e: unknown) {
        return { success: false, error: `Cannot verify file: ${input.path}: ${e}` }
      }
      try {
        const currentBytes = await fs.readFile(real)
        if (!currentBytes.equals(originalBytes)) {
          return { success: false, error: "File changed after read. Read it again before editing." }
        }
      } catch (e: unknown) {
        return { success: false, error: `Cannot verify file: ${input.path}: ${e}` }
      }

      try {
        const finalContent = joinBom(convertToLineEnding(replaced, ending), bom)
        await fs.writeFile(real, finalContent, "utf-8")
        const count = countOccurrences(replaced, newString) - countOccurrences(sourceText, newString)

        // 清除缓存
        invalidateFileState(real)

        // 编辑后诊断自检（不阻塞主流程，超时/失败静默降级）
        let diagnosticNote = ""
        if (ctx.workspace) {
          try {
            const diagResult = await lspManager.getDiagnosticsAfterEdit(ctx.workspace, real)
            if (diagResult.checked) {
              const { formatDiagnosticCheck } = await import("../../lsp/diagnostic-check")
              diagnosticNote = formatDiagnosticCheck(diagResult)
            }
          } catch {
            // 诊断自检失败不影响编辑结果
          }
        }

        const diffOutput = createTwoFilesPatch(
          input.path,
          input.path,
          sourceText,
          replaced,
          "",
          "",
          { context: 3 },
        )
        const baseOutput = `Edited ${real}: ${Math.max(count, 1)} replacement(s)\n\n${limitDiffLines(diffOutput, 50)}`
        const finalOutput = diagnosticNote ? `${baseOutput}\n\n${diagnosticNote}` : baseOutput
        return {
          success: true,
          output: finalOutput,
          metadata: {
            replacements: Math.max(count, 1),
            path: real,
            snapshotId,
            ...(diagnosticNote ? { diagnostics: diagnosticNote } : {}),
          },
        }
      } catch (e: unknown) {
        return { success: false, error: `Cannot write ${input.path}: ${e}` }
      }
    })
  },
})

// ─── LSP 增强编辑回退 ─────────────────────────────────

/**
 * 当 9 种字符串匹配策略全部失败时，尝试通过 LSP 符号分析定位代码块。
 * 提取 oldString 中的函数/变量名，用 LSP documentSymbols 找到其定义范围，
 * 然后用文件中的实际文本作为 oldString 重新执行替换。
 */
async function tryLspEnhancedEdit(
  filePath: string,
  oldString: string,
  newString: string,
  fileContent: string,
  workspace?: string,
): Promise<{ replaced: string; usedOldString: string } | null> {
  if (!workspace) return null

  // 从 oldString 中提取可能的符号名
  const symbolName = extractSymbolName(oldString)
  if (!symbolName) return null

  try {
    const client = await lspManager.ensureServer(workspace)
    if (!client?.isRunning) return null

    const uri = pathToFileURL(filePath).href
    client.openDocument(uri, detectLanguage(filePath), fileContent)

    // 获取文档符号列表
    const symbols = await client.documentSymbols(uri)

    // 递归查找匹配的符号
    const found = findSymbolInTree(symbols, symbolName)
    if (!found) {
      client.closeDocument(uri)
      return null
    }

    const range = (found.range || found.selectionRange) as { start: { line: number }; end: { line: number } } | null
    if (!range) {
      client.closeDocument(uri)
      return null
    }

    const lines = fileContent.split("\n")
    const startLine = range.start.line
    const endLine = range.end.line

    // 从文件中提取该范围的文本作为旧字符串
    const actualOldString = lines.slice(startLine, endLine + 1).join("\n")

    // 验证提取的文本是否包含在我们的 oldString 关键内容中
    const oldStripped = oldString.replace(/\s+/g, "").slice(0, 100)
    const actualStripped = actualOldString.replace(/\s+/g, "").slice(0, 100)

    if (actualStripped === oldStripped || oldStripped.includes(actualStripped) || actualStripped.includes(oldStripped)) {
      // 用实际文本替换
      const replaced = fileContent.replace(actualOldString, newString)
      if (replaced !== fileContent) {
        client.closeDocument(uri)
        return { replaced, usedOldString: actualOldString }
      }
    }

    client.closeDocument(uri)
    return null
  } catch {
    return null
  }
}




