/**
 * Worktree 隔离系统 — Git worktree 集成 + 目录隔离
 * 替代 Python worktree_manager.py
 */

import { execSync } from "child_process"
import { join, relative, resolve } from "path"
import fs from "fs"
import { getPlatformPaths } from "../config/paths"

export interface WorktreeInfo {
  id: string
  path: string
  branch: string
  taskId: string
  createdAt: number
  lastUsedAt: number
  isGitWorktree: boolean
}

const WORKTREE_DIR = "worktrees"
let worktreesDir = ""

function getWorktreesDir(): string {
  if (!worktreesDir) {
    worktreesDir = join(getPlatformPaths().userData, WORKTREE_DIR)
    if (!fs.existsSync(worktreesDir)) fs.mkdirSync(worktreesDir, { recursive: true })
  }
  return worktreesDir
}

function isGitRepo(path: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: path, stdio: "pipe", timeout: 3000 })
    return true
  } catch { return false }
}

/** 为任务创建隔离的工作目录 */
export function createWorktree(taskId: string, projectPath: string): WorktreeInfo {
  const id = `wt-${Date.now().toString(36)}`
  const branch = `task/${taskId.replace(/[^a-zA-Z0-9_-]/g, "-")}`
  const wtPath = join(getWorktreesDir(), id)

  fs.mkdirSync(wtPath, { recursive: true })

  let isGitWorktree = false

  if (isGitRepo(projectPath)) {
    try {
      execSync(`git worktree add "${wtPath}" -b "${branch}"`, {
        cwd: projectPath, stdio: "pipe", timeout: 30000,
      })
      isGitWorktree = true
    } catch {
      // Git worktree 失败（如未提交的更改），使用普通目录
    }
  }

  // 如果不是 Git worktree，复制项目文件
  if (!isGitWorktree) {
    try {
      execSync(`xcopy /E /I /Q /Y "${projectPath}\\*" "${wtPath}"`, { timeout: 30000 })
    } catch { /* 复制失败不影响 */ }
  }

  const worktree: WorktreeInfo = {
    id, path: wtPath, branch, taskId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    isGitWorktree,
  }

  saveWorktreeInfo(worktree)
  return worktree
}

/** 在工作目录中执行命令 */
export function runInWorktree(worktreeId: string, command: string): string {
  const info = getWorktreeInfo(worktreeId)
  if (!info) throw new Error(`Worktree not found: ${worktreeId}`)
  if (!fs.existsSync(info.path)) throw new Error(`Worktree path not found: ${info.path}`)

  info.lastUsedAt = Date.now()
  saveWorktreeInfo(info)

  return execSync(command, { cwd: info.path, encoding: "utf-8", timeout: 60000 })
}

/** 关闭并清理工作目录 */
export function closeoutWorktree(worktreeId: string): void {
  const info = getWorktreeInfo(worktreeId)
  if (!info) return

  if (info.isGitWorktree) {
    try {
      // 提交更改并移除 worktree
      execSync(`git add -A && git commit -m "task ${info.taskId}"`, {
        cwd: info.path, stdio: "pipe", timeout: 30000,
      })
      execSync(`git worktree remove "${info.path}"`, {
        cwd: info.path, stdio: "pipe", timeout: 30000,
      })
    } catch {
      // worktree 移除失败时，尝试普通删除
    }
  }

  // 清理目录
  try {
    fs.rmSync(info.path, { recursive: true, force: true })
  } catch { /* 静默 */ }

  // 从记录中移除
  const records = loadAllWorktrees().filter((w) => w.id !== worktreeId)
  fs.writeFileSync(getRecordsPath(), JSON.stringify(records, null, 2), "utf-8")
}

function getRecordsPath(): string {
  return join(getWorktreesDir(), "worktrees.json")
}

function loadAllWorktrees(): WorktreeInfo[] {
  try {
    const path = getRecordsPath()
    if (fs.existsSync(path)) {
      return JSON.parse(fs.readFileSync(path, "utf-8")) as WorktreeInfo[]
    }
  } catch { /* 静默 */ }
  return []
}

function saveWorktreeInfo(info: WorktreeInfo): void {
  const records = loadAllWorktrees().filter((w) => w.id !== info.id)
  records.push(info)
  fs.writeFileSync(getRecordsPath(), JSON.stringify(records, null, 2), "utf-8")
}

export function getWorktreeInfo(worktreeId: string): WorktreeInfo | undefined {
  return loadAllWorktrees().find((w) => w.id === worktreeId)
}

export function listWorktrees(): WorktreeInfo[] {
  return loadAllWorktrees()
}

export function cleanupWorktrees(): void {
  for (const wt of loadAllWorktrees()) {
    if (!fs.existsSync(wt.path)) {
      closeoutWorktree(wt.id)
    }
  }
}

