/**
 * selfmod HTTP 端点测试
 * 验证：/api/selfmod/status、/api/selfmod/plugins、/api/selfmod/plugin/client
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createMiraContext } from "../framework/services"
import { setupSelfModification, DynamicPluginRunner } from "../selfmod"
import { startServer } from "../system/server"
import type { Server } from "http"

const HOOK_PLUGIN_CODE = `
  return { name: 'server-plugin', apply(ctx) { ctx.on('x', () => {}) } }
`

let server: Server
let baseUrl: string
let authToken: string
let serverCtx: Awaited<ReturnType<typeof createMiraContext>>
let runner: DynamicPluginRunner
let pluginId = ""
let packageId = ""

async function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

describe("selfmod HTTP 端点", () => {
  beforeAll(async () => {
    serverCtx = await createMiraContext()
    runner = setupSelfModification(serverCtx)
    const { server: s, port, token } = await startServer({ port: 0, host: "127.0.0.1" })
    server = s
    baseUrl = `http://127.0.0.1:${port}`
    authToken = token
    // 预置一个带 client half 的插件
    const { pluginId: pid, packageId: pkid } = runner.define("sess-1", "srv-plugin", "服务端插件", HOOK_PLUGIN_CODE, "return { render() { return '<div>hi</div>' } }")
    pluginId = pid
    packageId = pkid
    await runner.run("sess-1", pid, pkid, "run")
  })

  afterAll(async () => {
    server.close()
  })

  it("GET /api/selfmod/status 应返回 enabled", async () => {
    const res = await fetch(`${baseUrl}/api/selfmod/status`, { headers: { Authorization: `Bearer ${authToken}` } })
    expect(res.status).toBe(200)
    const data = await res.json() as { enabled: boolean }
    expect(data.enabled).toBe(true)
  })

  it("POST /api/selfmod/plugins 应列出会话插件", async () => {
    const { status, data } = await post("/api/selfmod/plugins", { sessionId: "sess-1" })
    expect(status).toBe(200)
    const d = data as { plugins: Array<{ pluginId: string; name: string; status?: string }>; enabled: boolean }
    expect(d.enabled).toBe(true)
    expect(d.plugins.some((p) => p.pluginId === pluginId && p.name === "srv-plugin")).toBe(true)
  })

  it("POST /api/selfmod/plugin/client 应返回 client 代码", async () => {
    const { status, data } = await post("/api/selfmod/plugin/client", { sessionId: "sess-1", pluginId, packageId })
    expect(status).toBe(200)
    const d = data as { ok: boolean; clientCode?: string }
    expect(d.ok).toBe(true)
    expect(d.clientCode).toContain("render")
  })

  it("POST /api/selfmod/plugin/client 无 client 时返回错误", async () => {
    const { status, data } = await post("/api/selfmod/plugin/client", { sessionId: "sess-1", pluginId, packageId: "nope" })
    expect(status).toBe(200)
    const d = data as { ok: boolean; error?: string }
    expect(d.ok).toBe(false)
    expect(d.error).toBeTruthy()
  })
})
