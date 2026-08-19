/**
 * SessionCwd — 会话级工作目录（参考 mimo change_directory + SessionCwd）
 *
 * 每个 session 维护一个当前工作目录（默认 = workspace）。
 * change_directory 工具设置后，后续文件工具的相对路径基于此解析，
 * 降低 monorepo 多目录切换时的心智负担。
 */

import { isAbsolute, resolve } from "path"

const cwdMap = new Map<string, string>()

/** 设置会话工作目录 */
export function setSessionCwd(sessionID: string, dir: string): void {
  cwdMap.set(sessionID, dir)
}

/** 获取会话工作目录（未设置返回 undefined，调用方回退 workspace） */
export function getSessionCwd(sessionID: string): string | undefined {
  return cwdMap.get(sessionID)
}

/** 重置会话工作目录（回到 workspace） */
export function resetSessionCwd(sessionID: string): void {
  cwdMap.delete(sessionID)
}

/** 清理会话工作目录（会话结束时） */
export function clearSessionCwd(sessionID: string): void {
  cwdMap.delete(sessionID)
}

/**
 * 解析会话内相对路径：基于 SessionCwd（若有）否则 workspace。
 * 绝对路径原样返回。
 */
export function resolveSessionPath(sessionID: string, workspace: string, inputPath: string): string {
  if (isAbsolute(inputPath)) return inputPath
  const cwd = getSessionCwd(sessionID)
  const base = cwd || workspace
  return resolve(base, inputPath)
}
