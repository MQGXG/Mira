/**
 * Cordis 框架基础功能验证
 * 验证 vendored Cordis 框架可独立运行：Context / 服务注册 / 插件加载 / 事件分发 / 可逆 effect
 */

import { describe, it, expect } from "vitest"
import { Context, Service, symbols } from "../cordis/index"
import type { Plugin } from "../cordis/registry"

// 演示 merge-extensible 事件表：测试专用事件通过 declare module 合并
declare module "../cordis/context" {
  interface Events {
    "test/emit"(): void
    "test/event"(): void
    "test/serial"(): void | string
    "test/parallel"(): void | Promise<void>
    "test/waterfall"(list: string[], next: () => unknown): unknown
    "test/waterfall-veto"(list: string[], next: () => unknown): unknown
  }
}

describe("Cordis 基础功能", () => {
  it("应创建根 Context 并暴露内建服务", () => {
    const ctx = new Context()
    expect(ctx).toBeDefined()
    expect(ctx.events).toBeDefined()
    expect(ctx.registry).toBeDefined()
    expect(ctx.reflect).toBeDefined()
    expect(ctx.logger).toBeDefined()
  })

  it("应支持服务注册与读取（ctx.provide / ctx.get）", () => {
    const ctx = new Context()
    const dispose = ctx.provide("testService", { hello: "world" })
    expect(ctx.get("testService")).toEqual({ hello: "world" })
    dispose()
    expect(ctx.get("testService")).toBeUndefined()
  })

  it("应支持 Service 子类注册为命名服务", () => {
    class TestService extends Service {
      constructor(ctx: Context) {
        super(ctx, "testSvc")
      }
      greet(): string {
        return "hello"
      }
    }
    const ctx = new Context()
    new TestService(ctx)
    const svc = ctx.get("testSvc") as TestService
    expect(svc).toBeInstanceOf(TestService)
    expect(svc.greet()).toBe("hello")
  })

  it("应支持插件加载（ctx.plugin）与卸载回滚", async () => {
    const ctx = new Context()
    let started = false
    let destroyed = false
    const plugin: Plugin = {
      name: "test-plugin",
      apply(ctx: Context, config: unknown) {
        started = true
        ctx.effect(() => () => {
          destroyed = true
        })
        ctx.on("test/event", () => {})
      },
    }
    const fiber = ctx.plugin(plugin, {})
    await fiber
    expect(started).toBe(true)
    expect(ctx.registry.has(plugin)).toBe(true)
    // 卸载
    ctx.registry.delete(plugin)
    await fiber
    expect(destroyed).toBe(true)
    expect(ctx.registry.has(plugin)).toBe(false)
  })

  it("应支持 inject 依赖声明（服务就绪后才激活插件）", async () => {
    const ctx = new Context()
    let applied = false
    ctx.plugin({
      name: "dep-plugin",
      inject: ["depService"],
      apply(ctx) {
        applied = true
        expect(ctx.get("depService")).toBeDefined()
      },
    })
    // 依赖未就绪时不立即执行
    expect(applied).toBe(false)
    // 提供依赖后激活
    ctx.provide("depService", { value: 1 })
    await ctx.plugin({ name: "noop", apply() {} })
    expect(applied).toBe(true)
  })

  it("应支持 emit 同步分发", () => {
    const ctx = new Context()
    let count = 0
    const dispose = ctx.on("test/emit", () => {
      count++
    })
    ctx.emit("test/emit")
    ctx.emit("test/emit")
    expect(count).toBe(2)
    dispose()
    ctx.emit("test/emit")
    expect(count).toBe(2)
  })

  it("应支持 waterfall 中间件链与短路", () => {
    const ctx = new Context()
    ctx.on("test/waterfall", (list, next) => {
      list.push("a")
      return next()
    })
    ctx.on("test/waterfall", (list, next) => {
      list.push("b")
      return next()
    })
    const list: string[] = []
    const result = ctx.waterfall("test/waterfall", list, () => "done")
    expect(result).toBe("done")
    expect(list).toEqual(["a", "b"])
  })

  it("应支持 waterfall 短路（不调 next 则后续监听器不执行）", () => {
    const ctx = new Context()
    ctx.on("test/waterfall-veto", (list, next) => {
      list.push("a")
      return "blocked"
    })
    ctx.on("test/waterfall-veto", (list, next) => {
      list.push("b")
      return next()
    })
    const list: string[] = []
    const result = ctx.waterfall("test/waterfall-veto", list, () => "done")
    expect(result).toBe("blocked")
    expect(list).toEqual(["a"])
  })

  it("应支持 serial 顺序分发并在 bail 值处停止", async () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.on("test/serial", () => {
      order.push("first")
    })
    ctx.on("test/serial", () => {
      order.push("second")
      return "bailed"
    })
    ctx.on("test/serial", () => {
      order.push("third")
    })
    const result = await ctx.serial("test/serial")
    expect(result).toBe("bailed")
    expect(order).toEqual(["first", "second"])
  })

  it("应支持 parallel 并行分发", async () => {
    const ctx = new Context()
    let a = 0
    let b = 0
    ctx.on("test/parallel", async () => {
      await new Promise((r) => setTimeout(r, 50))
      a = 1
    })
    ctx.on("test/parallel", async () => {
      b = 1
    })
    await ctx.parallel("test/parallel")
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it("应支持 child context 继承服务", () => {
    const ctx = new Context()
    ctx.provide("parentSvc", 42)
    const child = ctx.extend()
    expect(child.get("parentSvc")).toBe(42)
  })

  it("should expose symbols for fiber diagnostics", () => {
    const ctx = new Context()
    expect(symbols).toBeDefined()
    expect(symbols.effect).toBeDefined()
  })
})
