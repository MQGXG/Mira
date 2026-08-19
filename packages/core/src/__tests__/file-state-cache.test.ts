import { describe, it, expect } from "vitest"
import {
  computeHash,
  setFileState,
  getFileState,
  isFileChanged,
  isContentChanged,
  invalidateFileState,
} from "../tools/core/file-state-cache"

describe("file-state-cache CAS", () => {
  const path = "C:\\workspace\\src\\foo.ts"

  it("computeHash 生成稳定的 SHA-256 摘要", () => {
    const h1 = computeHash("const a = 1")
    const h2 = computeHash("const a = 1")
    const h3 = computeHash("const a = 2")
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toHaveLength(16)
  })

  it("setFileState 自动计算并缓存 hash", () => {
    setFileState(path, { content: "abc", mtimeMs: 100, byteLength: 3 })
    const state = getFileState(path)
    expect(state?.hash).toBe(computeHash("abc"))
  })

  it("isContentChanged 检测内容被外部修改", () => {
    setFileState(path, { content: "original", mtimeMs: 100, byteLength: 8 })
    expect(isContentChanged(path, "original")).toBe(false)
    expect(isContentChanged(path, "modified!")).toBe(true)
  })

  it("isFileChanged 基于 mtime 检测", () => {
    setFileState(path, { content: "x", mtimeMs: 100, byteLength: 1 })
    expect(isFileChanged(path, 100)).toBe(false)
    expect(isFileChanged(path, 200)).toBe(true)
  })

  it("invalidateFileState 清除缓存", () => {
    setFileState(path, { content: "x", mtimeMs: 100, byteLength: 1 })
    invalidateFileState(path)
    expect(getFileState(path)).toBeUndefined()
    expect(isContentChanged(path, "x")).toBe(false)
  })
})
