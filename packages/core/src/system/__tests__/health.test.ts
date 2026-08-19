import { describe, it, expect, vi } from "vitest"
import { waitForHealth, rendererBootWindow } from "../health"

describe("waitForHealth（带超时轮询）", () => {
  it("健康端点就绪即返回（不重试）", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    const ok = await waitForHealth("http://127.0.0.1:1/health", { fetchFn: fetchMock as unknown as typeof fetch, timeoutMs: 1000, intervalMs: 20 })
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("端点未就绪时重试直到超时返回 false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    const ok = await waitForHealth("http://127.0.0.1:1/health", { fetchFn: fetchMock as unknown as typeof fetch, timeoutMs: 100, intervalMs: 20 })
    expect(ok).toBe(false)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it("网络错误视为未就绪并继续重试", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    const ok = await waitForHealth("http://127.0.0.1:1/health", { fetchFn: fetchMock as unknown as typeof fetch, timeoutMs: 100, intervalMs: 20 })
    expect(ok).toBe(false)
  })

  it("从失败过渡到健康时提前返回 true", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, status: 200 })
    const ok = await waitForHealth("http://127.0.0.1:1/health", { fetchFn: fetchMock as unknown as typeof fetch, timeoutMs: 1000, intervalMs: 20 })
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("rendererBootWindow（boot 超时判定）", () => {
  it("未超时返回 false", () => {
    expect(rendererBootWindow(Date.now() - 10_000, Date.now(), 30_000)).toBe(false)
  })
  it("超时返回 true", () => {
    expect(rendererBootWindow(Date.now() - 31_000, Date.now(), 30_000)).toBe(true)
  })
  it("30s 临界点不超时", () => {
    const now = Date.now()
    expect(rendererBootWindow(now - 30_000, now, 30_000)).toBe(false)
  })
})
