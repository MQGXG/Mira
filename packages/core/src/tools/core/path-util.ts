import * as fs from "fs/promises"
import * as path from "path"

/** 二进制扩展名黑名单 */
const BINARY_EXTS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar", ".xz",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".wma",
  ".mp4", ".avi", ".mkv", ".mov", ".wmv",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".wasm", ".pyc", ".pyo", ".class", ".jar",
  ".db", ".sqlite", ".sqlite3",
  ".ico", ".cur",
])

/** 设备文件正则 — 防止读取会挂起的设备文件 */
const DEVICE_FILE_RE = /^\/dev\/(zero|null|random|urandom|tty|stdin|stdout|stderr|fd\/\d+)/i
const WIN_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i

/** 跨平台路径归一化 */
export function windowsPath(p: string): string {
  if (process.platform !== "win32") return p
  return p
    .replace(/^\/([a-zA-Z]):(?:\/|$)/, (_, d: string) => `${d.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, d: string) => `${d.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, d: string) => `${d.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, d: string) => `${d.toUpperCase()}:/`)
}

/** 获取真实路径（含符号链接解析） */
export async function realPath(p: string): Promise<string> {
  try { return await fs.realpath(p) } catch { return p }
}

/** 路径包含检测 — 防止穿越 */
export function contains(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** 检测是否为二进制扩展名 */
export function isBinaryExt(ext: string): boolean {
  return BINARY_EXTS.has(ext.toLowerCase())
}

/** 检测是否为设备文件（会挂起的特殊文件） */
export function isDeviceFile(p: string): boolean {
  if (DEVICE_FILE_RE.test(p)) return true
  const basename = path.basename(p).split(".")[0]
  if (WIN_DEVICE_RE.test(basename)) return true
  return false
}
