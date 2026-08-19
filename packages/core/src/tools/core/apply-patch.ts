/**
 * apply_patch — 多文件批量编辑工具
 *
 * 补丁格式（参考 Codex / OpenCode）:
 * ```
 * *** Begin Patch
 * *** Add File: path/to/new.ts
 * + line1
 * + line2
 * *** Update File: path/to/existing.ts
 * @@ context anchor
 * - old line
 * + new line
 *   unchanged line
 * *** Delete File: path/to/old.ts
 * *** End Patch
 * ```
 *
 * 匹配策略（4 层模糊匹配）:
 * 1. exact     — 完全相等
 * 2. rstrip    — 仅去掉末尾空白
 * 3. trim      — 去掉两端空白
 * 4. normalized — 空白归一化 + Unicode 归一化
 */

import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"
import { make, type Content } from "../../shared/tool"
import { getSnapshotManager } from "../../session/snapshot"
import { realPath, contains, isDeviceFile } from "./path-util"
import { invalidateFileState } from "./file-state-cache"
import { unescapeModelOutput } from "./escape-util"
import { createTwoFilesPatch } from "diff"

// ─── 类型定义 ───────────────────────────────────────────

interface UpdateChunk {
  oldLines: string[]
  newLines: string[]
  changeContext?: string
  endOfFile?: boolean
}

type Hunk =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; chunks: UpdateChunk[] }

interface PatchDelta {
  operation: "added" | "updated" | "deleted" | "skipped" | "failed"
  path: string
  error?: string
}

// ─── 补丁解析器 ─────────────────────────────────────────

const BEGIN_PATCH_RE = /^\*\*\*\s*Begin\s*Patch\s*$/im
const END_PATCH_RE = /^\*\*\*\s*End\s*Patch\s*$/im
const ADD_FILE_RE = /^\*\*\*\s*Add\s+File:\s+(.+)$/im
const UPDATE_FILE_RE = /^\*\*\*\s*Update\s+File:\s+(.+)$/im
const DELETE_FILE_RE = /^\*\*\*\s*Delete\s+File:\s+(.+)$/im
const END_OF_FILE_RE = /^\*\*\*\s*End\s+of\s+File\s*$/im
const CONTEXT_RE = /^@@\s*(.+)$/
const MAX_PATCH_SIZE = 100_000 // 100KB 上限

function parsePatch(raw: string): { hunks: Hunk[]; error?: string } {
  const hunks: Hunk[] = []

  // 反转义模型输出的特殊标记
  let text = unescapeModelOutput(raw)

  // 剥离可能的 heredoc 包裹（兼容 GPT 等模型的错误格式）
  const heredocMatch = text.match(/<<['"]?(\w+)['"]?\n([\s\S]*?)\n\1/)
  if (heredocMatch) text = heredocMatch[2].trim()
  if (text.startsWith("```")) text = text.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "").trim()

  const beginMatch = text.match(BEGIN_PATCH_RE)
  if (!beginMatch) return { hunks: [], error: "缺少 *** Begin Patch 标记" }
  const endMatch = text.match(END_PATCH_RE)
  if (!endMatch) return { hunks: [], error: "缺少 *** End Patch 标记" }

  const body = text.substring(beginMatch.index! + beginMatch[0].length, endMatch.index).trim()
  if (body.length > MAX_PATCH_SIZE) return { hunks: [], error: "补丁内容超过 100KB 上限" }

  // 按文件分割
  const fileBlocks = body.split(/(?=^\*\*\*)/m).filter(Boolean)
  for (const block of fileBlocks) {
    const trimmed = block.trim()
    if (!trimmed) continue

    const addMatch = trimmed.match(ADD_FILE_RE)
    const updateMatch = trimmed.match(UPDATE_FILE_RE)
    const deleteMatch = trimmed.match(DELETE_FILE_RE)

    if (addMatch) {
      const targetPath = addMatch[1].trim()
      const lines = trimmed.split("\n")
      const contentLines: string[] = []
      let inContent = false
      for (const line of lines) {
        if (line.startsWith("***")) { inContent = true; continue }
        if (inContent && line.startsWith("+")) {
          contentLines.push(line.slice(1))
        }
      }
      hunks.push({ type: "add", path: targetPath, content: contentLines.join("\n") })

    } else if (deleteMatch) {
      hunks.push({ type: "delete", path: deleteMatch[1].trim() })

    } else if (updateMatch) {
      const targetPath = updateMatch[1].trim()
      const lines = trimmed.split("\n")
      const chunks: UpdateChunk[] = []
      let currentOld: string[] = []
      let currentNew: string[] = []
      let context = ""
      let eof = false
      let inHunk = false

      for (const line of lines) {
        if (line.startsWith("*** Add") || line.startsWith("*** Delete") || line.startsWith("*** Update")) {
          // 保存上一个 hunk
          if (inHunk && (currentOld.length > 0 || currentNew.length > 0)) {
            chunks.push({ oldLines: currentOld, newLines: currentNew, changeContext: context || undefined, endOfFile: eof })
            currentOld = []; currentNew = []; context = ""; eof = false
          }
          if (line.startsWith("*** Update")) inHunk = true
          else inHunk = false
          continue
        }

        if (line.startsWith("*** End of File")) { eof = true; continue }
        if (!inHunk) continue

        const ctxMatch = line.match(CONTEXT_RE)
        if (ctxMatch) {
          if (inHunk && (currentOld.length > 0 || currentNew.length > 0)) {
            chunks.push({ oldLines: currentOld, newLines: currentNew, changeContext: context || undefined, endOfFile: eof })
            currentOld = []; currentNew = []; eof = false
          }
          context = ctxMatch[1].trim()
          continue
        }

        if (line.startsWith("-")) { currentOld.push(line.slice(1)); if (currentNew.length === 0) currentNew.push("") }
        else if (line.startsWith("+")) { currentNew.push(line.slice(1)); if (currentOld.length === 0) currentOld.push("") }
        else if (line.startsWith(" ")) { currentOld.push(line.slice(1)); currentNew.push(line.slice(1)) }
      }

      if (inHunk && (currentOld.length > 0 || currentNew.length > 0)) {
        chunks.push({ oldLines: currentOld, newLines: currentNew, changeContext: context || undefined, endOfFile: eof })
      }

      if (chunks.length > 0) {
        hunks.push({ type: "update", path: targetPath, chunks })
      } else {
        hunks.push({ type: "update", path: targetPath, chunks: [{ oldLines: [], newLines: [] }] })
      }
    }
  }

  return { hunks }
}

// ─── 4 层模糊匹配 ──────────────────────────────────────

function exact(a: string, b: string): boolean { return a === b }
function rstrip(a: string, b: string): boolean { return a.trimEnd() === b.trimEnd() }
function trim(a: string, b: string): boolean { return a.trim() === b.trim() }

function normalized(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s.replace(/[‘’‚‛]/g, "'")
     .replace(/[“”„‟]/g, '"')
     .replace(/[‐‑‒–—―]/g, "-")
     .replace(/…/g, "...")
     .replace(/\u00A0/g, " ")
     .trim()
  return normalize(a) === normalize(b)
}

const COMPARE_FNS = [exact, rstrip, trim, normalized]

function matches(lines: string[], pattern: string[], offset: number, compare: (a: string, b: string) => boolean): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (!compare(lines[offset + i], pattern[i])) return false
  }
  return true
}

function seek(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (pattern.length === 0) return -1
  if (start > lines.length - pattern.length && !eof) return -1

  for (const compare of COMPARE_FNS) {
    if (eof) {
      const offset = lines.length - pattern.length
      if (offset >= start && matches(lines, pattern, offset, compare)) return offset
    }
    for (let offset = start; offset <= lines.length - pattern.length; offset++) {
      if (matches(lines, pattern, offset, compare)) return offset
    }
  }
  return -1
}

// ─── 补丁应用 ───────────────────────────────────────────

const APPLY_WRITE_LOCK = new Map<string, Promise<void>>()

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = APPLY_WRITE_LOCK.get(filePath) || Promise.resolve()
  const next = prev.then(fn, fn)
  APPLY_WRITE_LOCK.set(filePath, next.then(() => {}, () => {}))
  return next
}

async function applyHunk(
  hunk: Hunk,
  workspace: string,
  deltas: PatchDelta[],
): Promise<void> {
  const isAbsolute = path.isAbsolute(hunk.path)
  const absolute = isAbsolute ? hunk.path : path.resolve(workspace, hunk.path)
  const root = await realPath(workspace)
  const resolved = isAbsolute ? absolute : path.resolve(root, hunk.path)
  if (!isAbsolute && !contains(root, resolved)) {
    deltas.push({ operation: "failed", path: hunk.path, error: "路径逃逸工作区" })
    return
  }

  if (isDeviceFile(resolved)) {
    deltas.push({ operation: "failed", path: hunk.path, error: "无法操作设备文件" })
    return
  }

  switch (hunk.type) {
    case "add":
      await applyAdd(hunk, resolved, workspace, deltas)
      break
    case "update":
      await applyUpdate(hunk, resolved, workspace, deltas)
      break
    case "delete":
      await applyDelete(hunk, resolved, deltas)
      break
  }
}

async function applyAdd(
  hunk: Hunk & { type: "add" },
  resolved: string,
  workspace: string,
  deltas: PatchDelta[],
): Promise<void> {
  const snapshotMgr = getSnapshotManager(workspace)
  await snapshotMgr.capture([resolved], `apply_patch add: ${hunk.path}`)

  await withFileLock(resolved, async () => {
    // 不覆盖已存在的文件
    try {
      await fs.access(resolved)
      deltas.push({ operation: "failed", path: hunk.path, error: "文件已存在，使用 *** Update 修改" })
      return
    } catch {}

    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, hunk.content, "utf-8")
    invalidateFileState(resolved)
    deltas.push({ operation: "added", path: hunk.path })
  })
}

async function applyUpdate(
  hunk: Hunk & { type: "update" },
  resolved: string,
  workspace: string,
  deltas: PatchDelta[],
): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(resolved, "utf-8")
  } catch {
    deltas.push({ operation: "failed", path: hunk.path, error: "文件不存在" })
    return
  }

  // 快照
  const snapshotMgr = getSnapshotManager(workspace)
  await snapshotMgr.capture([resolved], `apply_patch update: ${hunk.path}`)

  await withFileLock(resolved, async () => {
    let modified = content
    let totalChanges = 0

    for (const chunk of hunk.chunks) {
      const oldLines = chunk.oldLines.filter(l => l !== "")
      const newLines = chunk.newLines.filter(l => l !== "")
      if (oldLines.length === 0 && newLines.length === 0) continue

      const lines = modified.split("\n")
      let start = 0

      // ChangeContext 锚点：先找到锚点，再从锚点后开始匹配
      if (chunk.changeContext) {
        const ctxMatch = seek(lines, [chunk.changeContext], 0, false)
        if (ctxMatch === -1) continue
        start = ctxMatch + 1
      }

      // 4 层模糊匹配
      let found = seek(lines, oldLines, start, chunk.endOfFile || false)

      // 尾部空行回退：如果 oldLines 末尾有空行但找不到，去掉再试
      if (found === -1 && oldLines.at(-1) === "") {
        const trimmedOld = oldLines.slice(0, -1)
        const trimmedNew = newLines.at(-1) === "" ? newLines.slice(0, -1) : newLines
        found = seek(lines, trimmedOld, start, chunk.endOfFile || false)
        if (found !== -1) {
          const before = lines.slice(0, found).join("\n")
          const after = lines.slice(found + trimmedOld.length).join("\n")
          modified = [before, ...trimmedNew, after].filter(Boolean).join("\n")
          totalChanges++
          continue
        }
      }

      if (found === -1) continue

      const before = lines.slice(0, found).join("\n")
      const after = lines.slice(found + oldLines.length).join("\n")
      modified = [before, ...newLines, after].filter(Boolean).join("\n")
      totalChanges++
    }

    if (totalChanges === 0) {
      deltas.push({ operation: "skipped", path: hunk.path, error: "未匹配到任何变更块" })
      return
    }

    // BOM 保留
    const bom = content.startsWith("\uFEFF") ? "\uFEFF" : ""
    const finalContent = bom + (bom ? modified : modified)

    try {
      await fs.writeFile(resolved, finalContent, "utf-8")
      invalidateFileState(resolved)

      // LSP 通知
      if (workspace) {
        import("../../lsp/manager").then(({ lspManager }) => {
          lspManager.touchFile(workspace, resolved).catch(() => {})
        }).catch(() => {})
      }

      // 生成 diff 报告
      const diff = createTwoFilesPatch(hunk.path, hunk.path, content, modified, "", "", { context: 2 })
      deltas.push({ operation: "updated", path: hunk.path, error: `${totalChanges} hunk(s) applied\n${limitDiffLines(diff, 40)}` })
    } catch (e: any) {
      deltas.push({ operation: "failed", path: hunk.path, error: `写入失败: ${e.message}` })
    }
  })
}

async function applyDelete(
  hunk: Hunk & { type: "delete" },
  resolved: string,
  deltas: PatchDelta[],
): Promise<void> {
  await withFileLock(resolved, async () => {
    try {
      await fs.access(resolved)
    } catch {
      deltas.push({ operation: "skipped", path: hunk.path, error: "文件不存在" })
      return
    }

    try {
      await fs.unlink(resolved)
      invalidateFileState(resolved)
      deltas.push({ operation: "deleted", path: hunk.path })
    } catch (e: any) {
      deltas.push({ operation: "failed", path: hunk.path, error: `删除失败: ${e.message}` })
    }
  })
}

function limitDiffLines(diff: string, maxLines: number): string {
  const lines = diff.split("\n")
  if (lines.length <= maxLines) return diff
  const head = lines.slice(0, Math.ceil(maxLines / 2)).join("\n")
  const tail = lines.slice(lines.length - Math.floor(maxLines / 2)).join("\n")
  return `${head}\n... (${lines.length - maxLines} lines truncated)\n${tail}`
}

// ─── 工具定义 ───────────────────────────────────────────

export const applyPatchTool = make({
  name: "apply_patch",
  description: `Apply a multi-file patch in batch. Supports adding, updating, and deleting files in a single call. Format:
*** Begin Patch
*** Add File: path/to/new.ts
+ file content
*** Update File: path/to/existing.ts
@@ context anchor line (optional, helps locate position)
- old line to replace
+ new line to add
  unchanged context line
*** Delete File: path/to/old.ts
*** End Patch

Lines starting with - are removed, + are added, space is context.
@@ provides a context anchor for fuzzy matching in large files.
4-level fuzzy matching: exact → trimmed whitespace → whitespace-normalized → unicode-normalized.
Use when: batch editing multiple files, creating files with content, deleting files, applying diff output.`,
  inputSchema: z.object({
    patch: z.string().describe("The patch content using *** Begin/End Patch format"),
    path: z.string().optional().describe("Optional base path (all relative paths resolved against this)"),
  }),
  outputSchema: z.string(),
  permission: "edit",
  toModelOutput(input, output): Content[] {
    return [{ type: "text", text: typeof output === "string" ? output : "" }]
  },
  async execute(input, ctx) {
    const { hunks, error: parseError } = parsePatch(input.patch)
    if (parseError) return { success: false, error: parseError }
    if (hunks.length === 0) return { success: false, error: "补丁中没有找到任何操作" }

    const workspace = input.path
      ? path.isAbsolute(input.path) ? input.path : path.resolve(ctx.workspace, input.path)
      : ctx.workspace

    const deltas: PatchDelta[] = []
    for (const hunk of hunks) {
      // 如果路径不是绝对路径，拼上 workspace
      const resolvedHunk = path.isAbsolute(hunk.path) ? hunk : { ...hunk, path: path.resolve(workspace, hunk.path) }
      await applyHunk(resolvedHunk, ctx.workspace, deltas)
    }

    // 汇总报告
    const added = deltas.filter(d => d.operation === "added").length
    const updated = deltas.filter(d => d.operation === "updated").length
    const deleted = deltas.filter(d => d.operation === "deleted").length
    const skipped = deltas.filter(d => d.operation === "skipped").length
    const failed = deltas.filter(d => d.operation === "failed").length

    const summary = `Applied patch: ${added} added, ${updated} updated, ${deleted} deleted` +
      (skipped > 0 ? `, ${skipped} skipped` : "") +
      (failed > 0 ? `, ${failed} failed` : "")

    const details = deltas
      .filter(d => d.operation === "updated" || d.operation === "failed")
      .map(d => {
        if (d.operation === "updated") return `  M ${d.path}\n${d.error}`
        if (d.operation === "failed") return `  ✗ ${d.path}: ${d.error}`
        return ""
      })
      .filter(Boolean)
      .join("\n\n")

    const hasFailures = failed > 0 || skipped > 0
    return {
      success: !hasFailures,
      output: hasFailures
        ? `${summary}\n\n${details}`.trim()
        : summary || "没有变更",
      metadata: { deltas },
    }
  },
})
