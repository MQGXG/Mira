import { describe, expect, test, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { readFileTool } from "../tools/core/read-file"

const dirs: string[] = []

function makeCtx(workspace: string) {
  return {
    sessionID: "test-session",
    workspace,
    mode: "assistant" as const,
    agent: "build",
    assistantMessageID: "",
    toolCallID: "",
  }
}

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mira-read-"))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("read_file 工具（createReadStream 修复回归）", () => {
  test("普通小文件读取（fastPath）", async () => {
    const dir = makeTempDir()
    const file = join(dir, "small.txt")
    writeFileSync(file, "line1\nline2\nline3\n", "utf-8")
    const result = await readFileTool.execute({ path: file, offset: 1 }, makeCtx(dir))
    expect(result.success).toBe(true)
    expect(result.output).toContain("line1")
    expect(result.output).toContain("line3")
  })

  test("小文件分页读取（offset/limit，触发 streamingPath）", async () => {
    const dir = makeTempDir()
    const file = join(dir, "paged.txt")
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`)
    writeFileSync(file, lines.join("\n"), "utf-8")
    // 读取第 10-20 行
    const result = await readFileTool.execute({ path: file, offset: 10, limit: 5 }, makeCtx(dir))
    expect(result.success).toBe(true)
    expect(result.output).toContain("line-10")
    expect(result.output).toContain("line-14")
    expect(result.output).not.toContain("line-20")
  })

  test("大文件读取（>STREAMING_THRESHOLD 触发 createReadStream 路径）", async () => {
    const dir = makeTempDir()
    const file = join(dir, "large.txt")
    // 构建 11MB 文件（> 10MB STREAMING_THRESHOLD）
    const chunk = "x".repeat(64 * 1024)
    const parts: string[] = []
    for (let i = 0; i < 200; i++) parts.push(`${i}-${chunk}`)
    writeFileSync(file, parts.join("\n"), "utf-8")
    const stat = statSync(file)
    expect(stat.size).toBeGreaterThan(10 * 1024 * 1024)

    const result = await readFileTool.execute({ path: file, offset: 1 }, makeCtx(dir))
    expect(result.success).toBe(true)
    // 内容被截断到 MAX_READ_BYTES，但应包含首行
    expect(result.output).toContain("0-xxx")
  })

  test("目录读取（readDirectory）", async () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, "a.txt"), "a", "utf-8")
    writeFileSync(join(dir, "b.txt"), "b", "utf-8")
    const result = await readFileTool.execute({ path: dir, offset: 1 }, makeCtx(dir))
    expect(result.success).toBe(true)
    expect(result.output).toContain("a.txt")
    expect(result.output).toContain("b.txt")
  })
})
