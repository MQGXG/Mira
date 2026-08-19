/**
 * Config Service — 配置管理
 */

export interface ConfigInfo {
  provider: string
  model: string
  apiUrl: string
  mode: string
  apiKeyFrom: "env" | "file" | "none"
  apiKey?: string
  headers?: Record<string, string>
  options?: Record<string, unknown>
}

export const ConfigService = {
  async get(workspace?: string): Promise<ConfigInfo> {
    return window.electronAPI.config.get(workspace)
  },

  async save(config: Record<string, unknown>): Promise<void> {
    return window.electronAPI.config.save(config)
  },

  async getProviderCatalog(): Promise<Array<{
    id: string; label: string; website?: string; defaultBaseUrl: string; authType: string
    models: Array<{ id: string; label?: string; context?: number; capabilities?: string[] }>
  }>> {
    return window.electronAPI.config.getProviderCatalog()
  },

  async encryptApiKey(text: string): Promise<string> {
    return window.electronAPI.encryptApiKey(text)
  },

  async decryptApiKey(encrypted: string): Promise<string> {
    return window.electronAPI.decryptApiKey(encrypted)
  },
}
