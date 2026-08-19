import { describe, expect, test } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { detectLanguageServer, getLanguageId, getServerDefForFile } from "../lsp/server-defs"
import { IndexingTracker } from "../lsp/indexing"
import { LSPDependencyResolver } from "../lsp/dependency"
import { diffDiagnostics, formatDiagnosticCheck, type DiagnosticCheckResult } from "../lsp/diagnostic-check"

describe("server-defs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-defs-test-"))

  test("检测 TypeScript 项目（tsconfig.json）", () => {
    fs.writeFileSync(path.join(tempDir, "tsconfig.json"), "{}")
    const def = detectLanguageServer(tempDir)
    expect(def).not.toBeNull()
    expect(def?.id).toBe("typescript")
  })

  test("检测 npm 项目（package.json）", () => {
    const dir = path.join(tempDir, "npm-proj")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "package.json"), "{}")
    const def = detectLanguageServer(dir)
    expect(def).not.toBeNull()
    expect(def?.id).toBe("typescript")
  })

  test("未知项目返回 null", () => {
    const dir = path.join(tempDir, "unknown")
    fs.mkdirSync(dir, { recursive: true })
    expect(detectLanguageServer(dir)).toBeNull()
  })

  test("按文件扩展名获取服务器定义", () => {
    expect(getServerDefForFile("src/index.ts")?.id).toBe("typescript")
    expect(getServerDefForFile("main.tsx")?.id).toBe("typescript")
    expect(getServerDefForFile("foo.py")).toBeNull()
  })

  test("获取 languageId（含 tsx 特殊处理）", () => {
    const def = detectLanguageServer(tempDir)
    expect(def).not.toBeNull()
    expect(getLanguageId(def!, "index.ts")).toBe("typescript")
    expect(getLanguageId(def!, "App.tsx")).toBe("typescriptreact")
    expect(getLanguageId(def!, "app.jsx")).toBe("javascriptreact")
    expect(getLanguageId(def!, "readme.md")).toBe("plaintext")
  })
})

describe("IndexingTracker", () => {
  test("初始状态为空闲", () => {
    const tracker = new IndexingTracker()
    expect(tracker.isIdle).toBe(true)
    expect(tracker.state.complete).toBe(true)
  })

  test("begin/end 后回到空闲", () => {
    const tracker = new IndexingTracker()
    tracker.begin("token-a")
    expect(tracker.isIdle).toBe(false)
    tracker.onProgress("token-a", "end")
    expect(tracker.isIdle).toBe(true)
  })

  test("多个 token 全部结束才空闲", () => {
    const tracker = new IndexingTracker()
    tracker.begin("a")
    tracker.begin("b")
    tracker.onProgress("a", "end")
    expect(tracker.isIdle).toBe(false)
    tracker.onProgress("b", "end")
    expect(tracker.isIdle).toBe(true)
  })

  test("waitForIndexing 在空闲时立即返回 true", async () => {
    const tracker = new IndexingTracker()
    await expect(tracker.waitForIndexing(100)).resolves.toBe(true)
  })

  test("waitForIndexing 等待所有任务完成后返回 true", async () => {
    const tracker = new IndexingTracker()
    tracker.begin("a")
    tracker.begin("b")

    const waitPromise = tracker.waitForIndexing(1000)
    setTimeout(() => {
      tracker.onProgress("a", "end")
      tracker.onProgress("b", "end")
    }, 50)

    await expect(waitPromise).resolves.toBe(true)
  })

  test("waitForIndexing 超时返回 false", async () => {
    const tracker = new IndexingTracker()
    tracker.begin("never-ending")
    await expect(tracker.waitForIndexing(50)).resolves.toBe(false)
  })

  test("reset 清空状态", () => {
    const tracker = new IndexingTracker()
    tracker.begin("a")
    tracker.reset()
    expect(tracker.isIdle).toBe(true)
  })

  test("记录最后一条进度消息", () => {
    const tracker = new IndexingTracker()
    tracker.onProgress("a", "begin", "Initializing JS/TS language features...")
    expect(tracker.state.lastMessage).toContain("Initializing")
  })
})

describe("LSPDependencyResolver", () => {
  test("自动安装禁用且未安装时返回 none", async () => {
    const resolver = new LSPDependencyResolver({
      cacheRoot: path.join(os.tmpdir(), "lsp-none-test-" + Date.now()),
      autoInstall: false,
    })
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-proj-"))
    fs.writeFileSync(path.join(projDir, "tsconfig.json"), "{}")
    const def = detectLanguageServer(projDir)
    expect(def).not.toBeNull()
    const result = await resolver.resolve(def!)
    expect(result.source).toBe("none")
  })
})

describe("diagnostic-check", () => {
  const diag = (message: string, range: { line: number; character: number }, severity = 1, code?: string) => ({
    range: { start: range, end: { line: range.line, character: range.character + 1 } },
    severity,
    message,
    ...(code ? { code } : {}),
  })

  test("无新增诊断时 diff 为空", () => {
    const before = [diag("err-a", { line: 1, character: 0 }, 1, "TS1")]
    const after = [diag("err-a", { line: 1, character: 0 }, 1, "TS1")]
    const diff = diffDiagnostics(before, after)
    expect(diff.newErrors).toHaveLength(0)
    expect(diff.newWarnings).toHaveLength(0)
  })

  test("识别新增错误与警告", () => {
    const before = [diag("err-a", { line: 1, character: 0 }, 1, "TS1")]
    const after = [
      diag("err-a", { line: 1, character: 0 }, 1, "TS1"),
      diag("new-error", { line: 5, character: 2 }, 1, "TS2322"),
      diag("new-warning", { line: 9, character: 0 }, 2, "TS6133"),
    ]
    const diff = diffDiagnostics(before, after)
    expect(diff.newErrors).toHaveLength(1)
    expect(diff.newErrors[0].message).toBe("new-error")
    expect(diff.newErrors[0].severity).toBe("error")
    expect(diff.newWarnings).toHaveLength(1)
    expect(diff.newWarnings[0].message).toBe("new-warning")
  })

  test("位置漂移不影响身份判定（以消息+代码为准）", () => {
    const before = [diag("same-msg", { line: 1, character: 0 }, 1, "TS1")]
    const after = [diag("same-msg", { line: 20, character: 5 }, 1, "TS1")]
    const diff = diffDiagnostics(before, after)
    expect(diff.newErrors).toHaveLength(0)
  })

  test("行号展示为 1-based", () => {
    const diff = diffDiagnostics([], [diag("x", { line: 3, character: 4 }, 1, "TS1")])
    expect(diff.newErrors[0].line).toBe(4)
    expect(diff.newErrors[0].column).toBe(5)
  })

  test("info/hint 不进入新增列表", () => {
    const diff = diffDiagnostics([], [diag("info", { line: 1, character: 0 }, 3)])
    expect(diff.newErrors).toHaveLength(0)
    expect(diff.newWarnings).toHaveLength(0)
  })

  test("formatDiagnosticCheck 输出摘要（无问题时不产生文本）", () => {
    const ok: DiagnosticCheckResult = {
      checked: true,
      baselineAvailable: true,
      newErrors: [],
      newWarnings: [],
      elapsedMs: 10,
    }
    expect(formatDiagnosticCheck(ok)).toContain("诊断检查通过")

    const bad: DiagnosticCheckResult = {
      checked: true,
      baselineAvailable: true,
      newErrors: [{ severity: "error", message: "boom", code: "TS2322", line: 5, column: 2 }],
      newWarnings: [],
      elapsedMs: 10,
    }
    const text = formatDiagnosticCheck(bad)
    expect(text).toContain("新增 1 个错误")
    expect(text).toContain("boom")
    expect(text).toContain("line 5:2")
  })

  test("未检查时 format 返回空串", () => {
    const result: DiagnosticCheckResult = {
      checked: false,
      baselineAvailable: false,
      newErrors: [],
      newWarnings: [],
      elapsedMs: 0,
    }
    expect(formatDiagnosticCheck(result)).toBe("")
  })
})
