/**
 * change_directory 工具 — 会话级工作目录切换（参考 mimo）
 *
 * 设置后，会话内文件工具（read_file/bash 等）的相对路径基于新目录解析。
 * 用 '~' 或空串重置回项目根。
 */

import { isAbsolute, resolve } from "path"
import * as fs from "fs"
import { z } from "zod"
import { make } from "../../shared/tool"
import { setSessionCwd, getSessionCwd, resetSessionCwd } from "./session-cwd"
import { contains } from "./path-util"

export const changeDirectoryTool = make({
  name: "change_directory",
  description: "Switch the working directory for the current session (like cd in a terminal). Subsequent relative file paths will be resolved relative to this directory. Use '~' or empty to reset to the project root. Use when the session needs to work in a subdirectory of a monorepo or multi-folder project.",
  inputSchema: z.object({
    path: z.string().describe("Directory to switch to. '~' or '' resets to the project root. Absolute or relative path."),
  }),
  outputSchema: z.string(),
  isReadOnly: true,
  execute(input, ctx) {
    const base = ctx.workspace || process.cwd()
    const target = (input.path || "").trim()

    // 重置回项目根
    if (!target || target === "~") {
      resetSessionCwd(ctx.sessionID)
      return Promise.resolve({ success: true, output: `Working directory reset to: ${base}` })
    }

    const cwd = getSessionCwd(ctx.sessionID) || base
    const abs = isAbsolute(target) ? target : resolve(cwd, target)

    let stat: fs.Stats | null = null
    try { stat = fs.statSync(abs) } catch { /* 不存在 */ }
    if (!stat || !stat.isDirectory()) {
      return Promise.resolve({ success: false, error: `Not a directory: ${abs}` })
    }

    // 外部目录需要审批（简化：拒绝并提示），项目内目录直接切换
    if (!contains(base, abs) && abs !== base) {
      return Promise.resolve({
        success: false,
        error: `Directory outside the workspace requires approval: ${abs}. Use absolute paths instead, or stay within: ${base}`,
      })
    }

    setSessionCwd(ctx.sessionID, abs)
    return Promise.resolve({ success: true, output: `Working directory set to: ${abs}` })
  },
})
