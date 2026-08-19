/**
 * 崩溃证据 — 移植 dsh-plugin-desktop crash-evidence
 *
 * sidecar 进程启动时写 active-run.json（userData/runtime/），干净退出时删除。
 * 下次启动若发现残留，判定上次异常退出（崩溃/强杀）。main 进程可经 readLastRun 只读探测。
 */

import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export interface CrashRunRecord {
  readonly startedAt: string
  readonly pid: number
  readonly version: string
}

export interface UnreadableCrashRun {
  readonly unreadable: true
}

export interface CrashRun {
  readonly previousRun: CrashRunRecord | UnreadableCrashRun | undefined
  /** 移除本进程的 active 标记（受 ownerId 保护，仅能删自己的） */
  markClean(): void
}

interface StoredCrashRun extends CrashRunRecord {
  readonly ownerId?: string
}

function lstatOptional(filename: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw cause
  }
}

function assertOwnedMarker(stats: NonNullable<ReturnType<typeof lstatSync>>): void {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
    throw new Error("mira: active run marker is invalid")
  }
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW
}

function readStoredRun(statePath: string): StoredCrashRun | UnreadableCrashRun | undefined {
  const pathStats = lstatOptional(statePath)
  if (pathStats === undefined) return undefined
  assertOwnedMarker(pathStats)
  const descriptor = openSync(statePath, constants.O_RDONLY | noFollowFlag())
  try {
    assertOwnedMarker(fstatSync(descriptor))
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"))
    if (typeof value !== "object" || value === null) return { unreadable: true }
    const record = value as Partial<StoredCrashRun>
    if (typeof record.startedAt !== "string"
      || typeof record.pid !== "number"
      || typeof record.version !== "string") return { unreadable: true }
    return {
      startedAt: record.startedAt,
      pid: record.pid,
      version: record.version,
      ...(typeof record.ownerId === "string" ? { ownerId: record.ownerId } : {}),
    }
  } catch (cause) {
    if (cause instanceof SyntaxError) return { unreadable: true }
    throw cause
  } finally {
    closeSync(descriptor)
  }
}

function unlinkTemporary(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
  }
}

function writeCurrentRun(statePath: string, currentRun: StoredCrashRun): void {
  const directory = dirname(statePath)
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const directoryStats = lstatSync(directory)
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("mira: active run directory is invalid")
  }
  try { chmodSync(directory, PRIVATE_DIRECTORY_MODE) } catch { /* 平台可能不支持 chmod */ }

  const temporary = join(directory, `.${basename(statePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(currentRun)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    })
    try { chmodSync(temporary, PRIVATE_FILE_MODE) } catch { /* 平台可能不支持 chmod */ }
    renameSync(temporary, statePath)
  } finally {
    unlinkTemporary(temporary)
  }
}

/** 只读探测上次标记（main 进程用，不写不改） */
export function readLastRun(statePath: string): CrashRunRecord | UnreadableCrashRun | undefined {
  const stored = readStoredRun(statePath)
  if (stored === undefined || "unreadable" in stored) return stored
  return { startedAt: stored.startedAt, pid: stored.pid, version: stored.version }
}

/** 持久化本次启动并返回上次异常退出的证据 */
export function beginDesktopRun(statePath: string, currentRun: CrashRunRecord): CrashRun {
  const storedPreviousRun = readStoredRun(statePath)
  const previousRun = storedPreviousRun === undefined || "unreadable" in storedPreviousRun
    ? storedPreviousRun
    : {
        startedAt: storedPreviousRun.startedAt,
        pid: storedPreviousRun.pid,
        version: storedPreviousRun.version,
      }
  const ownerId = randomUUID()
  writeCurrentRun(statePath, { ...currentRun, ownerId })
  let clean = false
  return {
    previousRun,
    markClean() {
      if (clean) return
      const storedRun = readStoredRun(statePath)
      if (storedRun === undefined || "unreadable" in storedRun || storedRun.ownerId !== ownerId) {
        clean = true
        return
      }
      unlinkSync(statePath)
      clean = true
    },
  }
}

/** 默认标记路径（基于 initPlatformPaths 的 userData） */
export function defaultCrashStatePath(userDataDir: string): string {
  return join(userDataDir, "runtime", "active-run.json")
}

/** 强制清理标记（正常退出路径兜底，win32 taskkill 下子进程无 exit 事件） */
export function clearCrashMarker(statePath: string): void {
  try { unlinkSync(statePath) } catch { /* 不存在/失败静默（幂等） */ }
}
