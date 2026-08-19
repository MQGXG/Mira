/**
 * Subprocess seam (capability: "subprocess")
 *
 * Service Definition: {@link SubprocessProvider} — run a command with args,
 * capturing output with timeout / abort handling. Consumed by bash and run_code.
 * Service Provider: {@link LocalSubprocessProvider} — default local implementation
 * wrapping node child_process.spawn.
 * Swapping the provider (e.g. to a remote sandbox) relocates command execution
 * product-wide without touching consumers.
 */

import { spawn, type ChildProcess } from "child_process"
import { capabilityRegistry } from "./index"
import { getSandbox } from "./sandbox"

export const SUBPROCESS_CAPABILITY = "subprocess"

const MAX_CAPTURE_BYTES = 1024 * 1024

export interface SubprocessResult {
  stdout: string
  stderr: string
  exitCode: number | null
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  signal?: boolean
}

export interface SubprocessOptions {
  timeoutMs: number
  signal?: AbortSignal
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface SubprocessProvider {
  readonly name: string
  run(command: string, args: string[], options: SubprocessOptions): Promise<SubprocessResult>
}

export class LocalSubprocessProvider implements SubprocessProvider {
  readonly name = "local"

  run(command: string, args: string[], options: SubprocessOptions): Promise<SubprocessResult> {
    return new Promise((resolve) => {
      const { timeoutMs, signal, cwd, env } = options
      // C2: 经 sandbox 缝包封（默认透传；换 provider 即整体加进程限制）
      const boxed = getSandbox().wrap(command, args, { cwd })
      const child: ChildProcess = spawn(boxed.command, boxed.args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal,
        cwd,
        env: env ?? process.env,
      })

      let stdout = ""
      let stderr = ""
      let stdoutTruncated = false
      let stderrTruncated = false
      let timedOut = false

      const timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
        setTimeout(() => { try { child.kill("SIGKILL") } catch { /* ignore */ } }, 2000)
      }, timeoutMs)

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE_BYTES) {
          const remaining = MAX_CAPTURE_BYTES - stdout.length
          stdout += chunk.slice(0, remaining).toString("utf8")
          if (stdout.length >= MAX_CAPTURE_BYTES) stdoutTruncated = true
        }
      })

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE_BYTES) {
          const remaining = MAX_CAPTURE_BYTES - stderr.length
          stderr += chunk.slice(0, remaining).toString("utf8")
          if (stderr.length >= MAX_CAPTURE_BYTES) stderrTruncated = true
        }
      })

      const onAbort = () => {
        clearTimeout(timeout)
        child.kill("SIGKILL")
        resolve({ stdout, stderr, exitCode: null, stdoutTruncated, stderrTruncated, timedOut: false, signal: true })
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", onAbort)
        const errorMsg = err.code === "ENOENT"
          ? `Command not found: "${boxed.command}". Make sure it is installed and in your PATH.`
          : `Failed to start command: ${err.message}`
        resolve({ stdout, stderr: stderr || errorMsg, exitCode: null, stdoutTruncated, stderrTruncated, timedOut })
      })

      child.on("close", (code) => {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", onAbort)
        resolve({ stdout, stderr, exitCode: code, stdoutTruncated, stderrTruncated, timedOut })
      })
    })
  }
}

const defaultSubprocessProvider = new LocalSubprocessProvider()

/** Get the active subprocess provider (registered one or local default). */
export function getSubprocess(): SubprocessProvider {
  return capabilityRegistry.get<SubprocessProvider>(SUBPROCESS_CAPABILITY) ?? defaultSubprocessProvider
}

export { defaultSubprocessProvider }
