/**
 * CapabilityRegistry - capability seam infrastructure (aligns with dsh capability-seams)
 *
 * A seam has three roles: a Service Definition (the provider interface),
 * a Service Provider (implementation), and a Consumer (commonly a model-facing tool).
 * Registering a provider makes it globally replaceable; swapping one provider
 * changes the whole product without touching consumers.
 *
 * Provider registration is reversible: `register` returns an unload function.
 */

export interface CapabilityDefinition {
  readonly name: string
  readonly description: string
}

export class CapabilityRegistry {
  private providers = new Map<string, unknown>()

  /** Register a provider for a capability; returns an unload function (reversible). */
  register<T>(name: string, provider: T): () => void {
    this.providers.set(name, provider)
    return () => {
      if (this.providers.get(name) === provider) this.providers.delete(name)
    }
  }

  /** Get the current provider for a capability. */
  get<T>(name: string): T | undefined {
    return this.providers.get(name) as T | undefined
  }

  list(): string[] {
    return Array.from(this.providers.keys())
  }

  clear(): void {
    this.providers.clear()
  }
}

export const capabilityRegistry = new CapabilityRegistry()
