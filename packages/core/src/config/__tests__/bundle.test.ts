/**
 * Bundle/patch 配置组合测试
 * 验证：bundle 注册/叠加、插件配置合并、patch 覆盖、dump-config
 */

import { describe, it, expect } from "vitest"
import { BundleRegistry, deepMerge } from "../bundle"

describe("配置组合（Bundle/patch）", () => {
  it("deepMerge 应深层合并对象", () => {
    expect(deepMerge({ a: 1, nested: { x: 1 } }, { nested: { y: 2 }, b: 3 }))
      .toEqual({ a: 1, nested: { x: 1, y: 2 }, b: 3 })
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 })
  })

  it("应注册并解析单个 bundle", () => {
    const reg = new BundleRegistry()
    reg.registerBundle({
      id: "code-analysis",
      label: "代码分析套件",
      plugins: [
        { name: "lsp-helper", config: { timeout: 5000 } },
        { name: "code-search" },
      ],
      patch: { "tools.bash.timeout": 60000 },
    })
    const result = reg.resolve(["code-analysis"])
    expect(result.plugins).toHaveLength(2)
    expect(result.plugins[0].config).toEqual({ timeout: 5000 })
    expect(result.patch).toEqual({ "tools.bash.timeout": 60000 })
    expect(result.applied).toEqual(["code-analysis"])
  })

  it("多个 bundle 叠加：插件按名字去重合并，后者配置覆盖", () => {
    const reg = new BundleRegistry()
    reg.registerBundle({ id: "base", label: "基础", plugins: [{ name: "p1", config: { a: 1 } }] })
    reg.registerBundle({ id: "extra", label: "扩展", plugins: [{ name: "p1", config: { b: 2 } }, { name: "p2" }] })
    const result = reg.resolve(["base", "extra"])
    expect(result.plugins).toHaveLength(2)
    const p1 = result.plugins.find((p) => p.name === "p1")!
    expect(p1.config).toEqual({ a: 1, b: 2 })
  })

  it("applyPatch 应覆盖插件启用状态与配置", () => {
    const reg = new BundleRegistry()
    reg.registerBundle({ id: "b", label: "B", plugins: [{ name: "p1", config: { timeout: 1000 } }] })
    const result = reg.resolve(["b"])
    reg.applyPatch(result, {
      plugins: { p1: { enabled: false, config: { timeout: 9999 } } },
      patch: { "tools.bash.timeout": 123 },
    })
    expect(result.plugins[0].enabled).toBe(false)
    expect(result.plugins[0].config).toEqual({ timeout: 9999 })
    expect(result.patch).toEqual({ "tools.bash.timeout": 123 })
  })

  it("dumpConfig 应打印实际启动树", () => {
    const reg = new BundleRegistry()
    reg.registerBundle({
      id: "analysis",
      label: "分析",
      plugins: [{ name: "lsp-helper" }, { name: "search", enabled: false }],
      patch: { "llm.maxTokens": 8000 },
    })
    const tree = reg.dumpConfig(["analysis"], undefined)
    expect(tree).toContain("analysis")
    expect(tree).toContain("lsp-helper")
    expect(tree).toContain("search")
    expect(tree).toContain("enabled")
    expect(tree).toContain("llm.maxTokens")
  })
})
