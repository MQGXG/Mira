import { describe, expect, test, afterEach } from "vitest"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { capabilityRegistry } from "../capability/index"
import { getOffice, type OfficeProvider } from "../capability/office"
import { OfficeCliProvider, createOfficeCliProvider } from "../capability/office-cli-provider"
import type { SubprocessProvider } from "../capability/subprocess"
import { requireOffice, runOfficeCli, formatJsonOutput, officeNotFoundResult, OFFICECLI_NOT_FOUND } from "../tools/office/office-cli"
import { officecliEditTool, officecliInspectTool, officecliGetTool, officecliQueryTool, officecliIssuesTool, officecliValidateTool, officecliMergeTool } from "../tools/office/officecli-tools"
import { registerOfficeTools } from "../system/registry-init"
import { ToolRegistry } from "../system/registry"

const ALL_OFFICE_TOOLS = [
  officecliInspectTool, officecliGetTool, officecliQueryTool,
  officecliIssuesTool, officecliValidateTool, officecliEditTool, officecliMergeTool,
]

const unsubs: Array<() => void> = []
function registerCap(name: string, provider: unknown): void {
  unsubs.push(capabilityRegistry.register(name, provider as never))
}
afterEach(() => {
  while (unsubs.length) unsubs.pop()!()
})

function mockOffice(run: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>): OfficeProvider {
  return { name: "mock-office", isAvailable: () => true, findPath: () => "mock", run }
}

function makeFakeBin(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "mira-office-"))
  const bin = join(dir, process.platform === "win32" ? "officecli.exe" : "officecli")
  writeFileSync(bin, "#!/bin/sh\necho fake", { mode: 0o755 })
  return { dir, bin }
}

describe("office capability seam", () => {
  test("默认无 provider → getOffice() 为 undefined（fail-closed 基座）", () => {
    expect(getOffice()).toBeUndefined()
  })

  test("注册 provider 后 getOffice 返回之，卸载回退 undefined", () => {
    const p = mockOffice(() => Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0, timedOut: false }))
    registerCap("office", p)
    expect(getOffice()).toBe(p)
    expect(getOffice()!.isAvailable()).toBe(true)
    // afterEach 卸载后回退
  })
})

describe("OfficeCliProvider 探测与执行", () => {
  test("candidates 显式注入覆盖内置探测", () => {
    const { bin } = makeFakeBin()
    const provider = createOfficeCliProvider([], { candidates: [bin] })
    expect(provider.isAvailable()).toBe(true)
    expect(provider.findPath()).toBe(bin)
    // 缓存命中：再次查询仍返回同一路径
    expect(provider.findPath()).toBe(bin)
  })

  test("无可探测二进制 → fail-closed（空 candidates）", () => {
    const provider = new OfficeCliProvider([], { candidates: [] })
    expect(provider.isAvailable()).toBe(false)
    expect(provider.findPath()).toBeNull()
  })

  test("OFFICECLI_PATH 环境变量优先", () => {
    const { bin } = makeFakeBin()
    const prev = process.env.OFFICECLI_PATH
    process.env.OFFICECLI_PATH = bin
    try {
      const provider = new OfficeCliProvider()
      expect(provider.isAvailable()).toBe(true)
      expect(provider.findPath()).toBe(bin)
    } finally {
      if (prev === undefined) delete process.env.OFFICECLI_PATH
      else process.env.OFFICECLI_PATH = prev
    }
  })

  test("run 经 subprocess 能力缝透传参数与超时", async () => {
    const { bin } = makeFakeBin()
    const calls: Array<{ bin: string; args: string[]; opts?: unknown }> = []
    const mockSub: SubprocessProvider = {
      name: "mock-sub",
      run: (b, args, opts) => {
        calls.push({ bin: b, args, opts })
        return Promise.resolve({
          stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0,
          stdoutTruncated: false, stderrTruncated: false, timedOut: false,
        })
      },
    }
    registerCap("subprocess", mockSub)
    const provider = createOfficeCliProvider([], { candidates: [bin] })
    const r = await provider.run(["view", "a.docx", "text", "--json"], { timeoutMs: 30_000, cwd: "/tmp" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('"ok"')
    expect(calls[0].bin).toBe(bin)
    expect(calls[0].args).toEqual(["view", "a.docx", "text", "--json"])
    expect((calls[0].opts as { timeoutMs?: number }).timeoutMs).toBe(30_000)
  })

  test("无二进制时 run 返回 127", async () => {
    const provider = new OfficeCliProvider([], { candidates: [] })
    const r = await provider.run(["view", "x.docx"])
    expect(r.exitCode).toBe(127)
  })
})

describe("office helper（fail-closed 归一化）", () => {
  test("requireOffice 无 provider → officecli_not_found 错误", () => {
    const res = requireOffice()
    expect(res.office).toBeNull()
    if (!res.error) throw new Error("expected error")
    expect(res.error.success).toBe(false)
    expect(res.error.metadata?.code).toBe(OFFICECLI_NOT_FOUND)
    expect(officeNotFoundResult().metadata?.code).toBe(OFFICECLI_NOT_FOUND)
  })

  test("requireOffice 有可用 provider → 返回 provider", () => {
    const p = mockOffice(() => Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false }))
    registerCap("office", p)
    const res = requireOffice()
    expect(res.error).toBeNull()
    expect(res.office).toBe(p)
  })

  test("runOfficeCli 归一化成功/失败/超时", async () => {
    const ok = mockOffice(() => Promise.resolve({ stdout: "content", stderr: "", exitCode: 0, timedOut: false }))
    expect((await runOfficeCli(ok, ["view", "a.docx"])).success).toBe(true)

    const fail = mockOffice(() => Promise.resolve({ stdout: "", stderr: "boom", exitCode: 2, timedOut: false }))
    const fr = await runOfficeCli(fail, ["validate", "a.docx"])
    expect(fr.success).toBe(false)
    expect(fr.error).toContain("boom")
    expect(fr.metadata?.exitCode).toBe(2)

    const timeout = mockOffice(() => Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: true }))
    const tr = await runOfficeCli(timeout, ["inspect", "a.docx"])
    expect(tr.success).toBe(false)
    expect(tr.metadata?.code).toBe("officecli_timeout")
  })

  test("formatJsonOutput 格式化 JSON、保留原文", () => {
    expect(formatJsonOutput({ stdout: '{"a":1}', stderr: "", exitCode: 0, timedOut: false })).toBe('{\n  "a": 1\n}')
    expect(formatJsonOutput({ stdout: "plain text", stderr: "", exitCode: 0, timedOut: false })).toBe("plain text")
    expect(formatJsonOutput({ stdout: "", stderr: "", exitCode: 0, timedOut: false })).toBe("(no output)")
  })
})

describe("officecli_* 条件注册（对齐 dsh 条件注入）", () => {
  test("office 可用 → 7 个工具全部注册", () => {
    const p = mockOffice(() => Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0, timedOut: false }))
    registerCap("office", p)
    const registry = new ToolRegistry()
    registerOfficeTools(registry)
    for (const t of ALL_OFFICE_TOOLS) expect(registry.get(t.name)).toBeDefined()
  })

  test("office 不可用 → 工具不注册（Agent 不可见）", () => {
    const registry = new ToolRegistry()
    registerOfficeTools(registry)
    for (const t of ALL_OFFICE_TOOLS) expect(registry.get(t.name)).toBeUndefined()
  })

  test("officecli_edit 无 provider 时 execute fail-closed", async () => {
    const r = await officecliEditTool.execute(
      { path: "a.docx", commands: [{ command: "add", parent: "/body", type: "paragraph", props: { text: "Hi" } }] },
      { sessionID: "s", workspace: ".", mode: "assistant", agent: "assistant", assistantMessageID: "m", toolCallID: "t" },
    )
    expect(r.success).toBe(false)
    expect(r.metadata?.code).toBe(OFFICECLI_NOT_FOUND)
  })

  test("officecli_inspect 参数 schema 有 permission=read；officecli_edit 为 edit", () => {
    expect(officecliInspectTool.permission).toBe("read")
    expect(officecliGetTool.permission).toBe("read")
    expect(officecliQueryTool.permission).toBe("read")
    expect(officecliIssuesTool.permission).toBe("read")
    expect(officecliValidateTool.permission).toBe("read")
    expect(officecliEditTool.permission).toBe("edit")
    expect(officecliMergeTool.permission).toBe("edit")
  })
})