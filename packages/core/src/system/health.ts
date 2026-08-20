/**
 * 启动健康检查 — 借鉴 dsh-plugin-desktop renderer-boot
 *
 * - rendererBootWindow：判定渲染层 boot 上报是否超时（main 30s 后弹恢复窗口）
 * 纯逻辑、无 Electron 依赖，便于 vitest 覆盖。
 * 注：waitForHealth 已移除——sidecar-bridge 自带健康轮询（10s 间隔 + 失败重连），不重复实现。
 */

/** 判定渲染层 boot 上报是否超时（startedAt 为窗口起点）。 */
export function rendererBootWindow(startedAt: number, now: number, timeoutMs: number): boolean {
  return now - startedAt > timeoutMs
}

/** 默认 boot 超时（对齐 DSH 的 RENDERER_BOOT_TIMEOUT_MS） */
export const RENDERER_BOOT_TIMEOUT_MS = 30_000
