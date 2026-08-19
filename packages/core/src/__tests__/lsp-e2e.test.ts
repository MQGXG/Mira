import { describe, expect, test } from "vitest"
import { lspManager } from "../lsp/manager"

// 端到端验证脚本：验证本地安装的 LSP 真实链路（依赖安装 → 启动 → 索引 → 查询）
// 依赖本机已安装 typescript-language-server，默认跳过；手动验证时改 describe.skip 为 describe
const E2E_WORKSPACE = "C:\\Users\\DEVENV~1\\AppData\\Local\\Temp\\opencode\\lsp-e2e-test"
const SAMPLE_FILE = "sample.ts"

describe.skip("LSP end-to-end (local install)", () => {
  test("getSymbols 返回文件符号大纲", async () => {
    const symbols = await lspManager.getSymbols(E2E_WORKSPACE, SAMPLE_FILE)
    const names = symbols.map((s) => s.name)
    expect(names).toContain("Greeter")
    expect(names).toContain("HelloGreeter")
    expect(names).toContain("create")
  }, 30_000)

  test("getDefinition 定位 create 函数定义", async () => {
    const locations = await lspManager.getDefinition(E2E_WORKSPACE, SAMPLE_FILE, 4, 10)
    expect(locations.length).toBeGreaterThan(0)
    expect(locations[0].uri).toContain("sample.ts")
  }, 30_000)

  test("getHoverInfo 返回类型信息", async () => {
    const info = await lspManager.getHoverInfo(E2E_WORKSPACE, SAMPLE_FILE, 4, 10)
    expect(info).not.toBeNull()
    expect(info!.contents.length).toBeGreaterThan(0)
  }, 30_000)

  test("waitForIndexing 就绪", async () => {
    await lspManager.ensureServer(E2E_WORKSPACE)
    const ready = await lspManager.waitForIndexing(E2E_WORKSPACE, 15_000)
    expect(ready).toBe(true)
  }, 30_000)
})
