/**
 * 运行期自修改服务 — 封装 electronAPI.selfmod IPC（动态插件状态 + client half）
 */

export interface SelfModPluginInfo {
  pluginId: string
  name: string
  packageCount: number
  currentPackageId?: string
  status?: string
  error?: string
}

const bridge = (): Window["electronAPI"] | undefined => window.electronAPI

/** 运行期自修改是否启用 */
export async function selfmodStatus(): Promise<boolean> {
  try {
    const r = await bridge()?.selfmod.status()
    return r?.enabled ?? false
  } catch {
    return false
  }
}

/** 列出会话内动态插件 */
export async function listSelfModPlugins(sessionId: string): Promise<SelfModPluginInfo[]> {
  try {
    const r = await bridge()?.selfmod.listPlugins(sessionId)
    return (r?.plugins ?? []) as SelfModPluginInfo[]
  } catch {
    return []
  }
}

/** 获取插件 client half 源码（渲染进程沙箱执行） */
export async function getSelfModClientCode(
  sessionId: string,
  pluginId: string,
  packageId?: string,
): Promise<{ ok: boolean; clientCode?: string; error?: string }> {
  try {
    return (await bridge()?.selfmod.getClientCode({ sessionId, pluginId, packageId })) ?? { ok: false, error: "bridge unavailable" }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
