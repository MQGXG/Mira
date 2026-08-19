/**
 * Sandbox seam (capability: "sandbox")
 *
 * Service Definition: {@link SandboxProvider} — wrap a command+args before spawn,
 * confining process execution (e.g. Landlock on Linux, remote e2b, OS-level
 * restrictions). Consumed by the subprocess provider.
 * Service Provider: {@link NoopSandboxProvider} — default pass-through (Mira desktop
 * relies on bash-security pre-checks today); swap to a real sandbox to confine
 * all child processes product-wide.
 */

import { capabilityRegistry } from "./index"

export const SANDBOX_CAPABILITY = "sandbox"

export interface SandboxedCommand {
  command: string
  args: string[]
  /** Confinement description for diagnostics (optional). */
  description?: string
}

export interface SandboxOptions {
  cwd?: string
}

export interface SandboxProvider {
  readonly name: string
  wrap(command: string, args: string[], options?: SandboxOptions): SandboxedCommand
}

/** Pass-through sandbox: executes the command as-is. */
export class NoopSandboxProvider implements SandboxProvider {
  readonly name = "none"

  wrap(command: string, args: string[]): SandboxedCommand {
    return { command, args }
  }
}

const defaultSandboxProvider = new NoopSandboxProvider()

/** Get the active sandbox provider (registered one or pass-through default). */
export function getSandbox(): SandboxProvider {
  return capabilityRegistry.get<SandboxProvider>(SANDBOX_CAPABILITY) ?? defaultSandboxProvider
}

export { defaultSandboxProvider }
