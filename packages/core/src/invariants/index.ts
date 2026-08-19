/**
 * InvariantRegistry - runtime contract checks (aligns with dsh per-package invariant)
 *
 * Declarative registration of invariant checkers validating event/data relations.
 * Controlled by the "invariants" feature flag (disabled by default to avoid runtime cost).
 */

import type { SessionEvent } from "../session/event-types"
import { isFeatureEnabled } from "../config/flags"

export interface InvariantContext {
  sessionId: string
  /** Events to check (ascending by seq) */
  events: SessionEvent[]
}

/** Invariant checker: returns null when passing, or a violation description string */
export interface Invariant {
  name: string
  check(ctx: InvariantContext): string | null
}

export class InvariantRegistry {
  private checks = new Map<string, Invariant>()

  register(invariant: Invariant): void {
    this.checks.set(invariant.name, invariant)
  }

  unregister(name: string): void {
    this.checks.delete(name)
  }

  list(): string[] {
    return Array.from(this.checks.keys())
  }

  /** Run all checks, returning violation list (empty = all pass) */
  runAll(ctx: InvariantContext): string[] {
    if (!isFeatureEnabled("invariants")) return []
    const violations: string[] = []
    for (const check of this.checks.values()) {
      try {
        const violation = check.check(ctx)
        if (violation) violations.push(`[${check.name}] ${violation}`)
      } catch (err) {
        violations.push(`[${check.name}] check threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return violations
  }
}

export const invariantRegistry = new InvariantRegistry()

/** Every tool-call must have a matching tool-result */
const toolCallResultPairing: Invariant = {
  name: "tool-call-result-pairing",
  check({ events }): string | null {
    const openCalls = new Set<string>()
    for (const ev of events) {
      const payload = ev.payload as Record<string, unknown>
      if (ev.type === "message.appended") {
        const content = payload?.content as { type: string; id?: string }[] | string | undefined
        if (!Array.isArray(content)) continue
        for (const part of content) {
          if (part?.type === "tool-call" && part.id) openCalls.add(part.id)
          else if (part?.type === "tool-result" && part.id) openCalls.delete(part.id)
        }
      }
    }
    if (openCalls.size > 0) {
      return `unpaired tool-call count: ${openCalls.size} -> ${[...openCalls].join(", ")}`
    }
    return null
  },
}

/** Token usage totals must be monotonically non-decreasing */
export const usageNonDecreasing: Invariant = {
  name: "usage-non-decreasing",
  check({ events }): string | null {
    let lastTotal = 0
    for (const ev of events) {
      const payload = ev.payload as Record<string, unknown>
      const total = payload?.totalTokens as number | undefined
      if (typeof total !== "number") continue
      if (total < lastTotal) {
        return `usage.totalTokens regressed from ${lastTotal} to ${total}`
      }
      lastTotal = total
    }
    return null
  },
}

export function registerDefaultInvariants(): void {
  invariantRegistry.register(toolCallResultPairing)
  invariantRegistry.register(usageNonDecreasing)
}