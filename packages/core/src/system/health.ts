/**
 * 启动健康检查 — 借鉴 dsh-plugin-desktop renderer-boot
 *
 * - waitForHealth：对 /api/health 做带超时轮询（sidecar 冷启动可能需数秒）
 * - rendererBootWindow：判定渲染层 boot 上报是否超时（main 30s 后弹恢复窗口）
 * 纯逻辑、无 Electron 依赖，便于 vitest 覆盖。
 */

export interface WaitForHealthOptions {
  fetchFn?: typeof fetch
  timeoutMs?: number
  intervalMs?: number
}

/** 轮询健康端点直到 200 或超时。默认超时 30s、间隔 200ms。 */
export async function waitForHealth(url: string, options: WaitForHealthOptions = {}): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  const intervalMs = options.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(url, { method: "GET" })
      if (res.ok) return true
    } catch {
      // 连接被拒/网络错误 → 未就绪，继续重试
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/** 判定渲染层 boot 上报是否超时（startedAt 为窗口起点）。 */
export function rendererBootWindow(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt > timeoutMs
}

/** 默认 boot 超时（对齐 DSH 的 RENDERER_BOOT_TIMEOUT_MS） */
export const RENDERER_BOOT_TIMEOUT_MS = 30_000
