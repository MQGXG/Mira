import * as path from "path"
import { z } from "zod"
import { make, type Content } from "../../shared/tool"
import { getSnapshotManager } from "../../session/snapshot"
import { realPath, contains } from "./path-util"
import { isFileChanged, setFileState } from "./file-state-cache"
import { getFs } from "../../capability/fs"

/** 进程级文件写入锁 — 同一文件串行写入 */
const writeLocks = new Map<string, Promise<void>>()

function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(filePath) || Promise.resolve()
  const next = prev.then(fn, fn)
  writeLocks.set(filePath, next.then(() => {}, () => {}))
  return next
}

const BOM = "\uFEFF"
function hasBom(text: string): boolean { return text.startsWith(BOM) }

export const writeFileTool = make({
  name: "write_file",
  description: "Create a new file or completely replace file content. Creates parent directories automatically. Safeguards: stale-content detection (refuses to overwrite if file changed externally since read), process-level write lock, BOM preservation. Use for new files or full rewrites. Do NOT use for: small edits (use edit_file), or creating documentation files unless explicitly requested. ALWAYS read the file first if it already exists.",
  inputSchema: z.object({
    path: z.string().describe("File path (absolute or relative to workspace)"),
    content: z.string().describe("Content to write"),
  }),
  outputSchema: z.string(),
  permission: "edit",
  toModelOutput(input, output): Content[] {
    return [{ type: "text", text: typeof output === "string" ? output : "" }]
  },
  async execute(input, ctx) {
    const isAbsolute = path.isAbsolute(input.path)
    const absolute = isAbsolute ? input.path : path.resolve(ctx.workspace, input.path)
    const root = await realPath(ctx.workspace)
    const resolved = isAbsolute ? absolute : path.resolve(root, input.path)
    if (!isAbsolute && !contains(root, resolved)) {
      return { success: false, error: `相对路径逃逸工作区: ${input.path}` }
    }

    // 快照：写入前捕获文件状态
    const snapshotMgr = getSnapshotManager(ctx.workspace)
    const snapshotId = await snapshotMgr.capture([resolved], `write_file: ${input.path}`)

    return withFileLock(resolved, async () => {
      await getFs().mkdir(path.dirname(resolved), true)

      // BOM 保留：检测原文件 BOM，新内容保留
      let content = input.content
      let existingContent = ""
      try {
        const raw = (await getFs().readFile(resolved)).toString("utf-8")
        existingContent = raw
        if (hasBom(raw) && !hasBom(content)) {
          content = BOM + content
        }
      } catch {
        // 新文件
      }

      // Stale 检测：文件被缓存标记为已变更则拒绝写入
      if (existingContent) {
        try {
          const stat = await getFs().stat(resolved)
          if (stat && isFileChanged(resolved, stat.mtimeMs)) {
            return {
              success: false,
              error: `File ${input.path} has been modified externally since it was last read. Read it again before writing.`,
            }
          }
        } catch {
          // 文件已不存在，忽略
        }
      }

      // 额外 stale 检测：内容级对比（解决 Windows mtime 抖动）
      if (existingContent) {
        try {
          const currentRaw = (await getFs().readFile(resolved)).toString("utf-8")
          if (currentRaw !== existingContent) {
            return {
              success: false,
              error: `File ${input.path} content changed externally. Read it again before writing.`,
            }
          }
        } catch {}
      }

      await getFs().writeFile(resolved, content)

      // 更新缓存：写入后记录新内容哈希作为 CAS 版本号
      const stat = await getFs().stat(resolved)
      setFileState(resolved, { content, mtimeMs: stat?.mtimeMs ?? Date.now(), byteLength: Buffer.byteLength(content, "utf-8") })

      // LSP 通知（写后刷新诊断）
      if (ctx.workspace) {
        import("../../lsp/manager").then(({ lspManager }) => {
          lspManager.touchFile(ctx.workspace, resolved).catch(() => {})
        }).catch(() => {})
      }

      return { success: true, output: `Wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${resolved}`, metadata: { snapshotId } }
    })
  },
})
