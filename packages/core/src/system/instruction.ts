/**
 * 指令上下文加载 — 自动加载全局和项目级 AGENTS.md / AGENTS.md
 * 参考 OpenCode packages/core/src/instruction-context.ts
 */

import { join, dirname } from "path"
import fs from "fs"
import { getPlatformPaths } from "../config/paths"

/** 从指定路径向上查找直到找到 .git 标志或达到根目录 */
export function findProjectRoot(start: string): string {
  let current = start
  if (!fs.existsSync(current)) return start

  const isWin = process.platform === "win32"
  while (true) {
    if (fs.existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) break // 已到根目录

    // Windows 盘符根目录 C:\ 的 dirname 还是 C:\
    if (isWin && parent === current) break
    current = parent
  }
  return start
}

/** 加载全局 AGENTS.md（~/.config/mira/AGENTS.md） */
export function loadGlobalInstructions(): string | null {
  try {
    const configDir = join(getPlatformPaths().home, ".config", "mira")
    const path = join(configDir, "AGENTS.md")
    if (fs.existsSync(path)) {
      return fs.readFileSync(path, "utf-8")
    }
  } catch {
    // 静默忽略
  }
  return null
}

/** 从 workspace 向上加载项目级 AGENTS.md */
export function loadProjectInstructions(workspace: string): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = []
  const projectRoot = findProjectRoot(workspace)

  // 从 workspace 向上收集所有 AGENTS.md
  let current = workspace
  while (true) {
    const p = join(current, "AGENTS.md")
    if (fs.existsSync(p)) {
      try {
        results.push({ path: p, content: fs.readFileSync(p, "utf-8") })
      } catch {
        // 跳过无法读取的文件
      }
    }
    if (current === projectRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return results.reverse() // 从根到 workspace 的顺序
}

/** 加载所有指令上下文并格式化为 system prompt 片段 */
export function buildInstructionSystemPrompt(workspace: string): string {
  const parts: string[] = []

  // 1. 全局指令
  const global = loadGlobalInstructions()
  if (global) {
    parts.push(`[Global Instructions from ~/.config/mira/AGENTS.md]\n${global}\n`)
  }

  // 2. 项目级指令
  const projectFiles = loadProjectInstructions(workspace)
  for (const file of projectFiles) {
    parts.push(`[Instructions from: ${file.path}]\n${file.content}\n`)
  }

  return parts.join("\n\n")
}

