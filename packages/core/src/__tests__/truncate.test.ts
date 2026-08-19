import { describe, expect, test, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { truncateToolOutput, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES } from "../shared/tool"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mira-truncate-"))

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }
})

describe("truncateToolOutput", () => {
  test("短输出不截断", () => {
    const r = truncateToolOutput("hello\nworld")
    expect(r.truncated).toBe(false)
    expect(r.content).toBe("hello\nworld")
    expect(r.outputPath).toBeUndefined()
  })

  test("超行数截断（head），preserve preview 不落盘（空 workspace）", () => {
    const input = Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n")
    const r = truncateToolOutput(input, { maxLines: 10 })
    expect(r.truncated).toBe(true)
    expect(r.removedLines).toBe(40)
    expect(r.content).toContain("lines truncated")
    expect(r.content).toContain("line-0")
    expect(r.content).not.toContain("line-49")
    expect(r.outputPath).toBeUndefined()
  })

  test("超字节截断（head）", () => {
    const input = "A".repeat(10_000)
    const r = truncateToolOutput(input, { maxBytes: 100 })
    expect(r.truncated).toBe(true)
    expect(r.content).toContain("bytes truncated")
  })

  test("tail 方向保留末尾", () => {
    const input = Array.from({ length: 20 }, (_, i) => `row-${i}`).join("\n")
    const r = truncateToolOutput(input, { maxLines: 5, direction: "tail" })
    expect(r.truncated).toBe(true)
    expect(r.content).toContain("row-19")
    expect(r.content).not.toContain("row-0")
  })

  test("提供 workspace+id 时落盘完整输出并附提示", () => {
    const input = Array.from({ length: 3000 }, (_, i) => `L${i}`).join("\n")
    const r = truncateToolOutput(input, { maxLines: 10, workspace: tmp, id: "abc" })
    expect(r.truncated).toBe(true)
    expect(r.outputPath).toBeDefined()
    expect(fs.existsSync(r.outputPath!)).toBe(true)
    const full = fs.readFileSync(r.outputPath!, "utf-8")
    expect(full.split("\n")).toHaveLength(3000)
    expect(r.content).toContain(`完整保存至: ${r.outputPath}`)
  })

  test("默认常量为 2000 行 / 50KB", () => {
    expect(DEFAULT_MAX_LINES).toBe(2000)
    expect(DEFAULT_MAX_BYTES).toBe(50 * 1024)
  })
})