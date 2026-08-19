import { z } from "zod"
import { make } from "../../shared/tool"
import path from "path"
import { checkCommand, normalizeCommand, splitSubCommands, isReadOnlyCommand } from "../core/bash-security"
import { getSessionCwd } from "../core/session-cwd"
import { parseExternalDirs } from "./bash-ast"
import { getSubprocess, type SubprocessResult } from "../../capability/subprocess"
import { getShell } from "../../capability/shell"

const MAX_OUTPUT_LENGTH = 50000
const MAX_CAPTURE_BYTES = 1024 * 1024

type RunResult = SubprocessResult

function runCommand(shell: string, args: string[], timeoutMs: number, signal?: AbortSignal, cwd?: string): Promise<RunResult> {
  // C2: 子进程执行经 subprocess 缝（可替换 provider 迁移到远程沙箱）
  return getSubprocess().run(shell, args, { timeoutMs, signal, cwd })
}

function compactOutput(stdout: string, stderr: string): string {
  if (stdout && stderr) return `${stdout}\n\nstderr:\n${stderr}`
  if (stderr) return `stderr:\n${stderr}`
  return stdout
}

function captureNotice(truncated: boolean, label: string): string | undefined {
  return truncated ? `[${label} capture truncated at ${MAX_CAPTURE_BYTES / 1024}KB in-memory safety limit]` : undefined
}

function formatOutput(result: RunResult): string {
  const compact = compactOutput(result.stdout, stderrDisplay(result))
  const notice = [captureNotice(result.stdoutTruncated, "stdout"), captureNotice(result.stderrTruncated, "stderr")]
    .filter(Boolean)
  const parts = [compact, ...notice]
  if (result.timedOut) {
    parts.push("Command timed out before completion. Retry with a larger timeout if the command is expected to take longer.")
  }
  return parts.join("\n\n")
}

function stderrDisplay(result: RunResult): string {
  return result.timedOut && !result.stderr ? "(killed on timeout)" : result.stderr
}

function externalCommandDirs(command: string, cwd: string): string[] {
  const dirs = new Set<string>()
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  for (const token of tokens) {
    const value = token.replace(/^(["'])(.*)\1$/, "$2").replace(/[;,&|]$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = path.resolve(value)
    if (resolved.startsWith(cwd)) continue
    dirs.add(path.dirname(resolved))
  }
  return [...dirs]
}

export const bashTool = make({
  name: "bash",
  description: "Execute shell commands (npm, git, system commands). Use for building, testing, installing packages. Use when: installing npm packages, running tests, checking git status, building projects, running scripts. Do NOT use for: reading file content (use read_file), searching (use grep), or simple time questions (use get_current_time). Prefer targeted commands over long chained ones.",
  inputSchema: z.object({
    command: z.string().describe("Shell command to execute"),
    timeout: z.number().optional().default(30).describe("Timeout in seconds (max 600)"),
    interactive: z.boolean().optional().default(false).describe("Set true if the command requires interactive stdin (sudo password, ssh passphrase, y/N prompt). When true, the tool will check for interactivity and return clear guidance instead of hanging."),
  }),
  outputSchema: z.string(),
  permission: "bash",

  async execute(input, ctx) {
    const check = checkCommand(input.command)
    if (check.level === "blocked") {
      return { success: false, error: `Blocked: ${check.reason}` }
    }

    // 交互式命令：当前环境不支持交互 stdin，给出明确引导而非静默挂起
    if (input.interactive) {
      return {
        success: false,
        error: `该命令声明为需要交互式终端（sudo 密码 / ssh 凭据 / y-N 确认）。当前环境不支持交互式 stdin。请：1) 改用无需交互的替代命令（如 ssh -o BatchMode=yes、用 --password-stdin 输入凭据）；2) 拆分命令为无需确认的步骤；3) 若必须交互，请让用户在终端手动执行。`,
      }
    }

    const cwd = getSessionCwd(ctx.sessionID) || ctx.workspace || process.cwd()
    const timeout = Math.min(input.timeout || 30, 600)

    // C2: shell 解析经 shell 缝（平台探测 + 参数构建可替换）
    const shell = getShell().resolve(ctx?.shell)
    const shellArgs = getShell().buildArgs(shell, input.command)

    // 路径级权限检测：tree-sitter AST（识别文件命令参数）+ token 匹配合并，
    // 覆盖 bash 与 powershell 两类语法，避免任一路径漏检
    const isWin = process.platform === "win32"
    const isPs = isWin && path.basename(shell).toLowerCase().startsWith("powershell")
    const astDirs = (await parseExternalDirs(input.command, cwd, isPs)) || []
    const tokenDirs = externalCommandDirs(input.command, cwd)
    const externalDirs = [...new Set([...astDirs, ...tokenDirs])]

    const result = await runCommand(shell, shellArgs, timeout * 1000, ctx.signal, cwd)

    if (result.signal) {
      return { success: false, error: "Command cancelled via abort signal", metadata: { exitCode: null } }
    }

    if (result.timedOut) {
      return {
        success: false,
        error: `Command timed out after ${timeout}s. Retry with a larger timeout if the command is expected to take longer.`,
        metadata: { exitCode: result.exitCode },
      }
    }

    const output = formatOutput(result)
    const truncated = output.length > MAX_OUTPUT_LENGTH
      ? output.slice(0, MAX_OUTPUT_LENGTH) + `\n\n[Output truncated at ${MAX_OUTPUT_LENGTH / 1000}K characters]\n💡 输出过大。可考虑委派子代理处理，或先用 grep 缩小搜索范围。`
      : output

    return {
      success: result.exitCode === 0,
      output: truncated || "(no output)",
      metadata: {
        exitCode: result.exitCode,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        ...(externalDirs.length > 0 ? { externalDirectories: externalDirs } : {}),
      },
    }
  },
})

