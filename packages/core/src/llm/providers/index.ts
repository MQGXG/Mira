import type { RouteInstance } from "../route/types"

export type ProviderType = string
export type ProviderInstance = RouteInstance

export interface ProviderConfig {
  protocol?: string
  label?: string
  defaultBaseUrl: string
  authType?: string
  authHeader?: string
  defaultModel?: string
  models?: string[]
  versionHeader?: { name: string; value: string }
  path?: string
  framing?: string
}
