import { describe, expect, test } from "vitest"
import * as fs from "fs"
import { lspManager } from "../lsp/manager"

// 端到端验证脚本：验证本地安装的 LSP 跨文件重命名（依赖本机 typescript-language-server，默认跳过）
// 注意：测试会真实改写文件，必须在完成后还原；手动验证时把 describe.skip 改为 describe
const E2E_FILE = "packages/core/src/lsp/diagnostic-check.ts"
const E2E_WORKSPACE = process.cwd()
const SYMBOL_LINE = 88 // 0-based：formatDiagnosticCheck 定义行
const SYMBOL_COL = 17
const TARGET_NAME = "formatDiagCheck"

describe.skip("LSP rename end-to-end (local install)", () => {
  test("跨文件重命名 formatDiagnosticCheck（会还原）", async () => {
    const orig = fs.readFileSync(E2E_FILE, "utf-8")
    try {
      const result = await lspManager.renameSymbol(E2E_WORKSPACE, E2E_FILE, SYMBOL_LINE, SYMBOL_COL, TARGET_NAME)
      expect(result.success).toBe(true)
      expect(result.fileCount).toBeGreaterThanOrEqual(1)
      expect(result.editCount).toBeGreaterThanOrEqual(1)
      // 定义文件应已改名
      expect(fs.readFileSync(E2E_FILE, "utf-8")).toContain(TARGET_NAME)
    } finally {
      fs.writeFileSync(E2E_FILE, orig, "utf-8")
    }
  }, 30_000)
})
