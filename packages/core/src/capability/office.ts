/**
 * Office seam (capability: "office")
 *
 * Service Definition: {@link OfficeProvider} — deterministic Office document
 * read/edit/validate/render via an external CLI (officecli). Consumed by the
 * officecli_* tools.
 * Service Provider: {@link OfficeCliProvider} — local implementation probing a
 * bundled / installed officecli binary (see office-cli-provider.ts).
 *
 * Unlike fs/shell/code-runtime there is intentionally NO default provider:
 * when the binary is unavailable the officecli_* tools stay unregistered
 * (conditional registration, fail-closed) and Office reading falls back to
 * ooxml-core. Swapping the provider relocates Office capability product-wide.
 */

import { capabilityRegistry } from "./index"

export const OFFICE_CAPABILITY = "office"

export interface OfficeResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}

export interface OfficeRunOptions {
  timeoutMs?: number
  cwd?: string
}

export interface OfficeProvider {
  readonly name: string
  /** Whether the officecli binary is available (probe chain hit). */
  isAvailable(): boolean
  /** The resolved binary path, or null when unavailable. */
  findPath(): string | null
  /** Run an officecli command (args exclude the binary itself). */
  run(args: string[], options?: OfficeRunOptions): Promise<OfficeResult>
}

/**
 * Get the active office provider.
 * Returns undefined when officecli is unavailable — consumers must fail-closed.
 */
export function getOffice(): OfficeProvider | undefined {
  return capabilityRegistry.get<OfficeProvider>(OFFICE_CAPABILITY)
}