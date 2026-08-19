import * as path from "path"
import { createHash } from "crypto"

export interface FileState {
  content: string
  mtimeMs: number
  byteLength: number
  /** 内容哈希（CAS 版本号）— 由写入方传入或读取时计算 */
  hash?: string
  offset?: number
  limit?: number
}

/** 跨工具文件状态缓存 — Read/Edit/Write 共享，防止并发修改冲突 */
const cache = new Map<string, FileState>()

/** 计算内容哈希（SHA-256）作为 CAS 版本号 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

/** 读取后存入缓存（同时计算内容哈希用于 CAS 校验） */
export function setFileState(filePath: string, state: FileState): void {
  cache.set(path.resolve(filePath), {
    ...state,
    hash: state.hash || computeHash(state.content),
  })
}

/** 获取缓存的文件状态 */
export function getFileState(filePath: string): FileState | undefined {
  return cache.get(path.resolve(filePath))
}

/** 检测文件是否已变化（比缓存中的 mtime 新） */
export function isFileChanged(filePath: string, currentMtimeMs: number): boolean {
  const state = cache.get(path.resolve(filePath))
  if (!state) return false
  return currentMtimeMs > state.mtimeMs
}

/**
 * CAS 校验 — 对比当前文件内容哈希与读取时缓存的哈希
 * 返回 true 表示文件已被外部修改（写入方应拒绝写入）
 */
export function isContentChanged(filePath: string, currentContent: string): boolean {
  const state = cache.get(path.resolve(filePath))
  if (!state) return false
  if (!state.hash) return false
  return computeHash(currentContent) !== state.hash
}

/** 写入/编辑后清除缓存 */
export function invalidateFileState(filePath: string): void {
  cache.delete(path.resolve(filePath))
}

/** 检测是否为重复读取（相同路径、相同分页参数、mtime 未变） */
export function isDuplicateRead(
  filePath: string,
  currentMtimeMs: number,
  currentByteLength: number,
  offset?: number,
  limit?: number,
): boolean {
  const state = cache.get(path.resolve(filePath))
  if (!state) return false
  return (
    state.mtimeMs === currentMtimeMs &&
    state.byteLength === currentByteLength &&
    state.offset === (offset || undefined) &&
    state.limit === (limit || undefined)
  )
}
