/**
 * Mira 框架适配层验证
 * 验证 createMiraContext 引导 + Context 服务寻址 + 类型化事件合并
 */

import { describe, it, expect } from "vitest"
import { createMiraContext } from "../services"
import type { Plugin } from "../../vendor/cordis/index"

// 演示 merge-extensible 事件表：测试专用事件通过 declare module 合并
declare module "../../vendor/cordis/context" {
  interface Events {
    "test/session-started"(session: { session_id: string }): void
  }
}

describe("Mira 框架适配层", () => {
  it("应创建带 catalog 服务的 Context", async () => {
    const ctx = await createMiraContext({ baseConfig: { workspace: "/tmp/ws" } })
    expect(ctx.get("catalog")).toBeDefined()
    expect(ctx.get("config")).toBeDefined()
    const cfg = ctx.get("config") as { getWorkspace(): string; getMode(): string }
    expect(cfg.getWorkspace()).toBe("/tmp/ws")
    expect(cfg.getMode()).toBe("assistant")
  })

  it("应通过 ctx.<服务名> 单一寻址空间访问服务", async () => {
    const ctx = await createMiraContext()
    expect(ctx.catalog).toBeDefined()
    expect(ctx.config).toBeDefined()
  })

  it("应支持插件通过 ctx.on 注册类型化事件监听", async () => {
    const ctx = await createMiraContext()
    const seen: string[] = []
    const plugin: Plugin = {
      name: "session-observer",
      apply(ctx) {
        ctx.on("session/start", (session) => {
          seen.push(session.sessionID ?? "")
        })
      },
    }
    await ctx.plugin(plugin)
    // 触发类型化事件（通过 Cordis emit）
    ctx.emit("session/start", { sessionID: "s1" })
    ctx.emit("session/start", { sessionID: "s2" })
    expect(seen).toEqual(["s1", "s2"])
    expect(ctx.registry.has(plugin)).toBe(true)
  })

  it("应支持 waterfall 事件（agent/pre-step 中间件）", async () => {
    const ctx = await createMiraContext()
    ctx.on("agent/pre-step", (messages, next) => {
      messages.push({ role: "system", content: "injected" } as never)
      return next()
    })
    const messages: unknown[] = [{ role: "user", content: "hi" }]
    ctx.waterfall("agent/pre-step", messages as never, () => [] as never)
    expect(messages).toHaveLength(2)
    expect((messages[1] as { role: string }).role).toBe("system")
  })
})
