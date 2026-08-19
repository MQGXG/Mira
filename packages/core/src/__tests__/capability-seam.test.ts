/**
 * Capability Seam 端到端测试 — "换 Provider 换产品"
 * 验证：ctx.fs.setProvider() 同步 capabilityRegistry 后，
 * 经 getFs() 的核心工具（read_file/list_files）立即跟随新 Provider。
 */

import { describe, it, expect, afterEach } from "vitest"
import { createMiraContext } from "../framework/services"
import { capabilityRegistry } from "../capability"
import { defaultFsProvider, FS_CAPABILITY } from "../capability/fs"
import { listFilesTool } from "../tools/core/list-files"
import { readFileTool } from "../tools/core/read-file"

// 恢复 capabilityRegistry（防污染其它测试）
afterEach(() => {
  capabilityRegistry.register(FS_CAPABILITY, defaultFsProvider)
})

const toolCtx = { workspace: "/ws", sessionID: "s1", mode: "assistant", agent: "build" } as never

describe("Capability Seam 端到端", () => {
  it("ctx.fs.setProvider 同步 capabilityRegistry（换 Provider 换产品）", async () => {
    const ctx = await createMiraContext()
    const mockFs = {
      name: "mock-fs",
      readFile: async () => Buffer.from("mock"),
      writeFile: async () => {},
      stat: async () => ({ size: 10, isDirectory: true, isFile: false, mtimeMs: 0 }),
      readdir: async () => [{ name: "a.txt" }, { name: "sub" }],
      mkdir: async () => {},
      exists: async () => true,
      createReadStream: () => undefined as never,
    }
    ctx.fs!.setProvider(mockFs as never)
    // capabilityRegistry 已同步 → getFs() 返回 mock
    expect(capabilityRegistry.get(FS_CAPABILITY)).toBe(mockFs)
    expect(capabilityRegistry.get(FS_CAPABILITY)).not.toBe(defaultFsProvider)
  })

  it("list_files 工具跟随新 Provider（mock fs 返回 mock 目录）", async () => {
    const ctx = await createMiraContext()
    const mockFs = {
      name: "mock-fs",
      readFile: async () => Buffer.from("mock"),
      writeFile: async () => {},
      stat: async () => ({ size: 10, isDirectory: true, isFile: false, mtimeMs: 0 }),
      readdir: async () => [{ name: "a.txt" }, { name: "sub" }],
      mkdir: async () => {},
      exists: async () => true,
      createReadStream: () => undefined as never,
    }
    ctx.fs!.setProvider(mockFs as never)
    const result = await listFilesTool.execute({ path: "." }, toolCtx)
    expect(result.success).toBe(true)
    expect(result.output).toContain("a.txt")
  })

  it("恢复本地 Provider 后 list_files 走真实文件系统", async () => {
    capabilityRegistry.register(FS_CAPABILITY, defaultFsProvider)
    const result = await listFilesTool.execute({ path: "." }, toolCtx)
    // 真实文件系统：workspace /ws 通常不存在 → 报错（说明走真实 fs 而非 mock）
    expect(result.success).toBe(false)
  })

  it("read_file 工具经 getFs seam（mock 返回内容）", async () => {
    const ctx = await createMiraContext()
    const mockFs = {
      name: "mock-fs",
      readFile: async () => Buffer.from("mock-content"),
      writeFile: async () => {},
      stat: async () => ({ size: 12, isDirectory: false, isFile: true, mtimeMs: 0 }),
      readdir: async () => [],
      mkdir: async () => {},
      exists: async () => true,
      createReadStream: () => undefined as never,
    }
    ctx.fs!.setProvider(mockFs as never)
    // read_file 走 getFs().readFile → 返回 mock 内容（经魔数检测不识别则按文本）
    const result = await readFileTool.execute({ path: "x.txt" } as never, toolCtx)
    expect(result.success).toBe(true)
    expect(result.output).toContain("mock-content")
  })
})
