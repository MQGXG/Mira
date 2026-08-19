/**
 * Shell seam (capability: "shell")
 *
 * Service Definition: {@link ShellProvider} — resolve the platform shell and
 * build its launch arguments for a command. Consumed by the bash tool.
 * Service Provider: {@link LocalShellProvider} — default local implementation
 * (Git Bash detection on Windows, shell arg conventions per platform).
 */

import { execSync } from "child_process"
import * as path from "path"
import * as fs from "fs"
import { capabilityRegistry } from "./index"

export const SHELL_CAPABILITY = "shell"

export interface ShellProvider {
  readonly name: string
  /** Resolve the shell executable path for the current platform / user preference. */
  resolve(preferred?: string): string
  /** Build launch arguments that make the shell eval `command`. */
  buildArgs(shell: string, command: string): string[]
}

function findGitBash(): string | undefined {
  if (process.platform !== "win32") return undefined
  try {
    const git = execSync("where git", { encoding: "utf8" })
      .split(/\r?\n/)[0]?.trim()
    if (!git) return undefined
    const bash = path.join(git, "..", "..", "bin", "bash.exe")
    return fs.existsSync(bash) ? bash : undefined
  } catch {
    return undefined
  }
}

function buildShellArgs(shell: string, command: string): string[] {
  const n = path.basename(shell).replace(/\.exe$/i, "").toLowerCase()
  if (n === "bash") {
    const script = `shopt -s expand_aliases\n[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true\neval ${JSON.stringify(command)}`
    return ["-l", "-c", script]
  }
  if (n === "wsl") return ["bash", "-c", command]
  if (n === "cmd") return ["/c", command]
  if (n === "powershell" || n === "pwsh") return ["-NoProfile", "-Command", command]
  return ["-c", command]
}

export class LocalShellProvider implements ShellProvider {
  readonly name = "local"

  resolve(preferred?: string): string {
    const isWin = process.platform === "win32"
    if (isWin) {
      if (preferred === "bash") return findGitBash() || "wsl"
      if (preferred === "cmd") return "cmd"
      return "powershell"
    }
    return preferred || "/bin/sh"
  }

  buildArgs(shell: string, command: string): string[] {
    return buildShellArgs(shell, command)
  }
}

const defaultShellProvider = new LocalShellProvider()

/** Get the active shell provider (registered one or local default). */
export function getShell(): ShellProvider {
  return capabilityRegistry.get<ShellProvider>(SHELL_CAPABILITY) ?? defaultShellProvider
}

export { defaultShellProvider }
