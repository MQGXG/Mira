import * as path from "path"
import { z } from "zod"
import { make, type Content } from "../../shared/tool"
import { lspManager } from "../../lsp/manager"
import { realPath, contains, isBinaryExt, isDeviceFile } from "./path-util"
import { setFileState, getFileState, isDuplicateRead } from "./file-state-cache"
import { resolveSessionPath } from "./session-cwd"
import { getFs } from "../../capability/fs"

const MAX_READ_BYTES = 50 * 1024 // 50KB 上限
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = " ...(truncated)"
const IMAGE_SIZE_LIMIT = 20 * 1024 * 1024 // 20MB

const SUPPORTED_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])
const SUPPORTED_IMAGE_MIMES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
}

/** 魔数检测 — 前几个字节标识文件类型 */
const MAGIC_BYTES: Array<{ bytes: number[]; ext: string }> = [
  { bytes: [0x89, 0x50, 0x4E, 0x47], ext: "PNG" },
  { bytes: [0xFF, 0xD8, 0xFF], ext: "JPEG" },
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: "GIF" },
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: "WebP" },
  { bytes: [0x25, 0x50, 0x44, 0x46], ext: "PDF" },
  { bytes: [0x50, 0x4B], ext: "ZIP/DOCX/XLSX" },
  { bytes: [0x1F, 0x8B], ext: "GZIP" },
  { bytes: [0x42, 0x4D], ext: "BMP" },
]

const IGNORE_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "target", "dist", "build", ".next", ".nuxt", "venv", "__pycache__", ".cache", ".idea", ".vscode"])

const NATIVE_ENCODINGS = new Set(["utf-8", "utf8", "utf-16le", "utf16le", "latin1", "ascii", "hex", "base64"])

function decodeText(buffer: Buffer, encoding: string): string {
  if (NATIVE_ENCODINGS.has(encoding)) {
    return buffer.toString(encoding as BufferEncoding)
  }
  try {
    const iconv = require("iconv-lite") as {
      encodingExists(enc: string): boolean
      decode(buffer: Buffer, enc: string): string
    }
    if (iconv.encodingExists(encoding)) {
      return iconv.decode(buffer, encoding)
    }
  } catch {}
  throw new Error(`Unsupported encoding: ${encoding}`)
}

/** 魔数检测 — 读取前 8 字节判断 */
function detectMagicType(buffer: Buffer): string | null {
  for (const { bytes, ext } of MAGIC_BYTES) {
    if (bytes.length <= buffer.length && bytes.every((b, i) => buffer[i] === b)) {
      return ext
    }
  }
  return null
}

/** 通过内容统计判断是否二进制（NUL + 不可打印字符比例） */
function isBinaryByContent(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true // NUL 字节
  if (buffer.length < 8) return false
  let nonPrintable = 0
  const sampleLen = Math.min(buffer.length, 4096)
  for (let i = 0; i < sampleLen; i++) {
    const b = buffer[i]
    if (b < 8 || (b > 14 && b < 32) || b === 127) nonPrintable++
  }
  return nonPrintable / sampleLen > 0.30
}

export const readFileTool = make({
  name: "read_file",
  description: "Read file content or list directory contents. Use this BEFORE modifying any file to understand its current state. Supports text files (with line offset/limit pagination, UTF-8 byte-accurate truncation, encoding detection), images (returned as viewable content), and directory listing. Use when: reading file content, checking code before editing, examining config files, listing directory contents, viewing images. After reading, present the actual content (or a faithful summary) directly in your reply — never narrate the reading process or add placeholder/meta notes.",
  inputSchema: z.object({
    path: z.string().describe("File or directory path (absolute, or relative to current directory which can be changed via change_directory)"),
    offset: z.number().optional().default(1).describe("1-based line or entry offset to start reading from"),
    limit: z.number().optional().describe("Max lines (for files) or entries (for directories) to read"),
    encoding: z.string().optional().describe("File encoding: utf-8 (default), utf-16le, latin1, gbk, shift-jis, big5. Requires iconv-lite for gbk/shift-jis/big5."),
  }),
  outputSchema: z.string(),
  permission: "read",
  toModelOutput(input, output): Content[] {
    if (typeof output === "object" && output !== null && (output as any).mime) {
      return [{ type: "file", data: (output as any).data, mime: (output as any).mime, name: (output as any).name }]
    }
    return []
  },
  async execute(input, ctx) {
    const isAbsolute = path.isAbsolute(input.path)
    const absolute = isAbsolute ? input.path : resolveSessionPath(ctx.sessionID, ctx.workspace, input.path)
    const real = await realPath(absolute)
    const root = await realPath(ctx.workspace)

    if (!isAbsolute && !contains(root, real)) {
      return { success: false, error: `相对路径逃逸工作区: ${input.path}` }
    }

    // 设备文件防护 — 防止读取会挂起的特殊文件
    if (isDeviceFile(real)) {
      return { success: false, error: `无法读取设备文件: ${input.path}` }
    }

    const stat = await getFs().stat(real)
    if (!stat) return { success: false, error: `Path does not exist: ${input.path}` }

    // 目录
    if (stat.isDirectory) {
      return await readDirectory(real, input, root)
    }

    const ext = path.extname(real).toLowerCase()

    // Read Dedup — 相同文件、相同分页参数、mtime 未变的重复读取直接返回存根
    if (isDuplicateRead(real, stat.mtimeMs, stat.size, input.offset, input.limit)) {
      const cached = getFileState(real)
      return {
        success: true,
        output: `[file_unread] ${input.path} (未更改，${stat.size} bytes，使用缓存)`,
      }
    }

    // 图片文件
    if (SUPPORTED_IMAGE_EXTS.has(ext)) {
      if (stat.size > IMAGE_SIZE_LIMIT) {
        return {
          success: true,
          output: `${real}\n${"─".repeat(40)}\n[图片] 文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 20MB 限制，无法读取。`,
        }
      }
      const buffer = await getFs().readFile(real)
      const mime = SUPPORTED_IMAGE_MIMES[ext] || "image/png"
      return {
        success: true,
        output: `${real} (${stat.size} bytes)\n${"─".repeat(40)}\n[图片] ${ext} 文件`,
        metadata: { mime, data: buffer.toString("base64"), name: path.basename(real) },
      }
    }

    // 二进制检测：扩展名 + 魔数 + 内容统计
    if (isBinaryExt(ext)) {
      return {
        success: true,
        output: `${real} (${stat.size} bytes)\n${"─".repeat(40)}\n[二进制文件] ${ext} 文件，不支持读取内容。`,
      }
    }

    const buffer = await getFs().readFile(real)
    const magicType = detectMagicType(buffer)
    if (magicType && !SUPPORTED_IMAGE_EXTS.has(ext)) {
      const knownBinaryFormats: Record<string, string> = {
        "PNG": "PNG 图片", "JPEG": "JPEG 图片", "GIF": "GIF 图片",
        "WebP": "WebP 图片", "PDF": "PDF 文档", "BMP": "BMP 图片",
        "ZIP/DOCX/XLSX": "ZIP/DOCX/XLSX 文件", "GZIP": "GZIP 压缩包",
      }
      return {
        success: true,
        output: `${real} (${stat.size} bytes)\n${"─".repeat(40)}\n[二进制文件] ${knownBinaryFormats[magicType] || magicType}`,
      }
    }

    if (isBinaryByContent(buffer)) {
      return {
        success: true,
        output: `${real} (${stat.size} bytes)\n${"─".repeat(40)}\n[二进制文件] 内容包含不可打印字符。`,
      }
    }

    return await readTextFile(real, buffer, input, input.path, ctx.workspace)
  },
})

/**
 * 双路径文本读取引擎：
 * - 快路径（≤10MB 且无分页参数）：readFile 一次读完 + split
 * - 流式路径（>10MB 或有分页）：createReadStream 按行扫描
 */
const STREAMING_THRESHOLD = 10 * 1024 * 1024 // 10MB

async function readTextFile(
  real: string,
  buffer: Buffer,
  input: { offset?: number; limit?: number; encoding?: string; path?: string },
  requestPath?: string,
  workspace?: string
): Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }> {
  const enc = (input.encoding || "utf-8").toLowerCase()
  const offset = (input.offset || 1) - 1
  const limit = input.limit || 0
  const hasPaging = limit > 0
  const isLarge = buffer.length > STREAMING_THRESHOLD

  // 快路径：小文件且无需分页 → 直接 decode 后 split
  if (!isLarge && !hasPaging) {
    return await fastPath(real, buffer, enc, input, requestPath, workspace)
  }

  // 流式路径：大文件或分页读取 → 流式扫描
  return await streamingPath(real, buffer.length, enc, offset, limit, input, requestPath, workspace)
}

/** 快路径 — 整文件读取 + 内存 split */
async function fastPath(
  real: string, buffer: Buffer, enc: string,
  input: { offset?: number; limit?: number; encoding?: string },
  requestPath?: string, workspace?: string,
): Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }> {
  let text: string
  try {
    text = decodeText(buffer, enc)
  } catch (e: any) {
    text = buffer.toString("utf-8")
    if (enc !== "utf-8") {
      return {
        success: true,
        output: `${real}\n${"-".repeat(40)}\n[编码警告] 指定编码 "${enc}" 解码失败，已回退 UTF-8。${e.message || ""}\n\n${text.slice(0, 50000)}`,
      }
    }
  }

  if (enc === "utf-8" && text.includes("\uFFFD")) {
    return {
      success: true,
      output: `${real}\n${"-".repeat(40)}\n[编码提示] 文件包含无效的 UTF-8 字节序列。尝试指定 encoding 参数:\n- GBK: read_file("${requestPath || real}", encoding="gbk")\n- UTF-16: read_file("${requestPath || real}", encoding="utf-16le")\n- Latin-1: read_file("${requestPath || real}", encoding="latin1")\n\n文件前 200 字符:\n${text.slice(0, 200)}`,
    }
  }

  const allLines = text.split("\n")
  const totalLines = allLines.length

  return buildOutput(real, allLines, totalLines, 0, 0, input, workspace)
}

/** 流式路径 — createReadStream 按行扫描，只加载目标范围到内存 */
async function streamingPath(
  real: string, fileSize: number, enc: string,
  offset: number, limit: number,
  input: { offset?: number; limit?: number; encoding?: string },
  requestPath?: string, workspace?: string,
): Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }> {
  return new Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }>((resolve, reject) => {
    const lines: string[] = []
    let lineIndex = 0
    let byteAccum = 0
    const maxLines = limit > 0 ? limit : 50000
    const targetEnd = limit > 0 ? offset + limit : Infinity
    let foundUtf8Error = false
    let truncated = false
    let error: string | undefined
    let resolved = false

    // 读整个文件流，按行过滤分页（offset/limit 是行号，不能作为字节 start/end）
    const stream = getFs().createReadStream(real)

    let leftover = ""

    // 完成处理：end 或提前截断（destroy）时统一收尾，防重入
    const finish = () => {
      if (leftover.length > 0 && lineIndex >= offset && lineIndex < targetEnd && !truncated) {
        const line = leftover.length > MAX_LINE_LENGTH ? leftover.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : leftover
        lines.push(line)
      }
      const totalLines = lineIndex + (leftover.length > 0 ? 1 : 0)
      if (error) {
        resolve({ success: true, output: `${real}\n${"-".repeat(40)}\n${error}\n\n${lines.join("\n").slice(0, 50000)}` })
        return
      }
      resolve(buildOutput(real, lines, totalLines, offset, truncated ? offset + lines.length : totalLines, input, workspace))
    }
    const done = () => { if (!resolved) { resolved = true; finish() } }

    stream.on("data", (chunk: string | Buffer) => {
      if (error || truncated) return

      let text: string
      if (typeof chunk === "string") {
        text = leftover + chunk
      } else {
        try {
          text = leftover + decodeText(Buffer.from(chunk), enc)
        } catch {
          if (!foundUtf8Error) {
            foundUtf8Error = true
            error = `[编码错误] 文件包含无效的 ${enc} 序列，尝试指定其他 encoding`
          }
          return
        }
      }

      const parts = text.split("\n")
      leftover = parts.pop() || ""

      for (const part of parts) {
        if (lineIndex >= targetEnd) { truncated = true; stream.destroy(); done(); return }

        if (lineIndex >= offset) {
          const line = part.length > MAX_LINE_LENGTH ? part.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : part
          lines.push(line)
          byteAccum += Buffer.byteLength(line, "utf-8") + 1

          if (lines.length >= maxLines || byteAccum > MAX_READ_BYTES) {
            truncated = true
            stream.destroy()
            done()
            return
          }
        }
        lineIndex++
      }
    })

    stream.on("end", () => {
      done()
    })

    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (!resolved) {
        resolved = true
        if (err.code === "ENOENT") {
          resolve({ success: false, error: `Path does not exist: ${requestPath || real}` })
        } else {
          resolve({ success: false, error: `读取失败: ${err.message}` })
        }
      }
    })
  })
}

/** 构建输出文本 */
async function buildOutput(
  real: string, lines: string[], totalLines: number,
  offset: number, nextLine: number,
  input: { offset?: number; limit?: number; encoding?: string },
  workspace?: string,
): Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }> {
  // 截断长行
  const processed = lines.map(l =>
    l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : l
  )

  let content = processed.join("\n")
  let contentBytes = Buffer.byteLength(content, "utf-8")
  let truncated = false
  let finalNextLine = nextLine || (input.offset || 1) - 1 + processed.length

  // 字节精确截断
  if (contentBytes > MAX_READ_BYTES) {
    const lineArray = content.split("\n")
    while (lineArray.length > 0) {
      const test = lineArray.slice(0, -1).join("\n")
      if (Buffer.byteLength(test, "utf-8") <= MAX_READ_BYTES) {
        content = test
        truncated = true
        finalNextLine = offset + lineArray.length
        break
      }
      lineArray.pop()
    }
    contentBytes = Buffer.byteLength(content, "utf-8")
  }

  const hasLimit = (input.limit || 0) > 0
  const header = hasLimit
    ? `${real} (${totalLines} lines, showing ${offset + 1}-${Math.min(finalNextLine, totalLines)})`
    : `${real} (${formatSize(contentBytes)})`

  let output = `${header}\n${"-".repeat(40)}\n${content}`
  const remaining = totalLines - finalNextLine

  if (remaining > 0) {
    output += `\n... (${remaining} more lines, use read_file with offset=${finalNextLine + 1}${input.limit ? `&limit=${input.limit}` : ""} to continue)`
  }

  if (truncated) {
    output += `\n💡 文件较大。可用 offset/limit 分页读取，或先用 grep 定位目标内容。`
  }

  // 存入文件状态缓存
  setFileState(real, {
    content: output,
    mtimeMs: (await getFs().stat(real))?.mtimeMs || Date.now(),
    byteLength: contentBytes,
    offset: input.offset,
    limit: input.limit,
  })

  // LSP 预热
  if (workspace) {
    lspManager.touchFile(workspace, real).catch(() => {})
  }

  return { success: true, output }
}

async function readDirectory(real: string, input: { offset?: number; limit?: number }, root: string): Promise<{ success: boolean; output: string }> {
  const allEntries = await getFs().readdir(real)
  const filtered = allEntries.filter((e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith("."))
  const total = filtered.length
  const offset = (input.offset || 1) - 1
  const limit = input.limit || 20

  const selected = filtered.slice(offset, offset + limit)

  // 并发 stat 确定类型（readdir 已提供类型信息，无需额外 stat）
  const lines = selected.map((e) => {
    const icon = e.isDirectory ? "📁" : e.isFile ? "📄" : "🔗"
    return `${icon}  ${e.name}`
  })

  const relative = path.relative(root, real) || "."
  const header = `📁 ${relative}/ (${total} entries, showing ${offset + 1}-${Math.min(offset + limit, total)})`
  let output = `${header}\n${"-".repeat(40)}\n${lines.join("\n")}`

  if (offset + limit < total) {
    output += `\n... (${total - offset - limit} more, use read_file with offset=${offset + limit + 1} to continue)`
  }
  const subdirs = selected.filter((e) => e.isDirectory && !IGNORE_DIRS.has(e.name))
  if (subdirs.length > 0) {
    output += `\n\n子目录: ${subdirs.map((e) => e.name).join(", ")}`
  }

  return { success: true, output }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
