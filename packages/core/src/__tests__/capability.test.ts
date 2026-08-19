import { describe, expect, test } from "vitest"
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import { capabilityRegistry } from "../capability/index"
import { getFs, LocalFileSystemProvider, type FileSystemProvider } from "../capability/fs"
import { getSubprocess, LocalSubprocessProvider, type SubprocessProvider } from "../capability/subprocess"
import { getCodeRuntime, LocalCodeRuntimeProvider, type CodeRuntimeProvider } from "../capability/code-runtime"
import { getShell, LocalShellProvider, type ShellProvider } from "../capability/shell"
import { getSandbox, NoopSandboxProvider, type SandboxProvider } from "../capability/sandbox"

describe("CapabilityRegistry", () => {
  test("register/get 返回 provider", () => {
    const provider = { name: "test" }
    const unsub = capabilityRegistry.register("test-cap", provider)
    expect(capabilityRegistry.get("test-cap")).toBe(provider)
    unsub()
    expect(capabilityRegistry.get("test-cap")).toBeUndefined()
  })

  test("register 返回可逆卸载函数", () => {
    const unsub = capabilityRegistry.register("x", { name: "x" })
    expect(capabilityRegistry.list()).toContain("x")
    unsub()
    expect(capabilityRegistry.list()).not.toContain("x")
  })
})

describe("fs capability (provider swap)", () => {
  test("默认 provider 为 LocalFileSystemProvider", () => {
    expect(getFs().name).toBe("local")
    expect(getFs()).toBeInstanceOf(LocalFileSystemProvider)
  })

  test("注册自定义 provider 后 getFs 返回新 provider，卸载后回退默认", async () => {
    const custom: FileSystemProvider = {
      name: "mock-fs",
      readFile: () => Promise.resolve(Buffer.from("mock")),
      writeFile: () => Promise.resolve(),
      stat: () => Promise.resolve({ size: 4, isDirectory: false, isFile: true, mtimeMs: 0 }),
      readdir: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      exists: () => Promise.resolve(true),
      createReadStream: () => Readable.from([]),
    }
    const unsub = capabilityRegistry.register("fs", custom)
    expect(getFs().name).toBe("mock-fs")
    expect((await getFs().readFile("/x")).toString()).toBe("mock")

    unsub()
    expect(getFs().name).toBe("local")
  })

  test("LocalFileSystemProvider 基础 IO", async () => {
    const fs = new LocalFileSystemProvider()
    const dir = mkdtempSync(join(tmpdir(), "mira-cap-"))
    const file = join(dir, "a.txt")
    writeFileSync(file, "hello", "utf-8")

    expect(await fs.exists(file)).toBe(true)
    expect((await fs.readFile(file)).toString()).toBe("hello")
    const st = await fs.stat(file)
    expect(st?.isFile).toBe(true)
    expect(st?.size).toBe(5)

    await fs.writeFile(file, "world")
    expect((await fs.readFile(file)).toString()).toBe("world")

    const entries = await fs.readdir(dir)
    expect(entries.some((e) => e.name === "a.txt")).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })
})

describe("subprocess capability (provider swap)", () => {
  test("默认 provider 为 LocalSubprocessProvider", () => {
    expect(getSubprocess().name).toBe("local")
    expect(getSubprocess()).toBeInstanceOf(LocalSubprocessProvider)
  })

  test("LocalSubprocessProvider 执行命令并捕获输出", async () => {
    const sp = new LocalSubprocessProvider()
    const isWin = process.platform === "win32"
    const cmd = isWin ? "cmd" : "sh"
    const args = isWin ? ["/c", "echo hello"] : ["-c", "echo hello"]
    const result = await sp.run(cmd, args, { timeoutMs: 5000 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("hello")
  })

  test("注册 mock provider 后 getSubprocess 返回新 provider，卸载回退默认", async () => {
    const mock: SubprocessProvider = {
      name: "mock-sub",
      run: () => Promise.resolve({ stdout: "mocked", stderr: "", exitCode: 0, stdoutTruncated: false, stderrTruncated: false, timedOut: false }),
    }
    const unsub = capabilityRegistry.register("subprocess", mock)
    expect(getSubprocess().name).toBe("mock-sub")
    expect((await getSubprocess().run("x", [], { timeoutMs: 100 })).stdout).toBe("mocked")
    unsub()
    expect(getSubprocess().name).toBe("local")
  })
})

describe("code-runtime capability", () => {
  test("默认 provider 为 LocalCodeRuntimeProvider", () => {
    expect(getCodeRuntime().name).toBe("local")
    expect(getCodeRuntime()).toBeInstanceOf(LocalCodeRuntimeProvider)
  })

  test("LocalCodeRuntimeProvider 执行 node 代码", async () => {
    const rt = new LocalCodeRuntimeProvider()
    const result = await rt.run({ code: "console.log('hi-runtime')", language: "node", timeoutMs: 10000 })
    expect(result.stdout).toContain("hi-runtime")
  })

  test("代码错误返回 stderr 与退出码", async () => {
    const rt = new LocalCodeRuntimeProvider()
    const result = await rt.run({ code: "throw new Error('boom')", language: "node", timeoutMs: 10000 })
    expect(result.stderr).toContain("boom")
  })

  test("注册 mock provider 换装", () => {
    const mock: CodeRuntimeProvider = {
      name: "mock-rt",
      run: () => Promise.resolve({ stdout: "mocked", stderr: "", exitCode: 0 }),
    }
    const unsub = capabilityRegistry.register("code-runtime", mock)
    expect(getCodeRuntime().name).toBe("mock-rt")
    unsub()
    expect(getCodeRuntime().name).toBe("local")
  })
})

describe("shell capability", () => {
  test("默认 provider 为 LocalShellProvider", () => {
    expect(getShell().name).toBe("local")
    expect(getShell()).toBeInstanceOf(LocalShellProvider)
  })

  test("buildArgs 按 shell 生成参数", () => {
    const sp = new LocalShellProvider()
    expect(sp.buildArgs("cmd", "dir")).toEqual(["/c", "dir"])
    expect(sp.buildArgs("powershell", "ls")).toEqual(["-NoProfile", "-Command", "ls"])
    expect(sp.buildArgs("/bin/bash", "echo hi")).toContain("-c")
  })

  test("resolve 返回平台默认 shell", () => {
    const sp = new LocalShellProvider()
    const shell = sp.resolve()
    expect(typeof shell).toBe("string")
    expect(shell.length).toBeGreaterThan(0)
  })

  test("注册 mock provider 换装", () => {
    const mock: ShellProvider = {
      name: "mock-shell",
      resolve: () => "mock-sh",
      buildArgs: (_s, cmd) => ["-c", cmd],
    }
    const unsub = capabilityRegistry.register("shell", mock)
    expect(getShell().name).toBe("mock-shell")
    expect(getShell().resolve()).toBe("mock-sh")
    unsub()
    expect(getShell().name).toBe("local")
  })
})

describe("sandbox capability", () => {
  test("默认 provider 为透传 NoopSandboxProvider", () => {
    expect(getSandbox().name).toBe("none")
    expect(getSandbox()).toBeInstanceOf(NoopSandboxProvider)
    const r = getSandbox().wrap("sh", ["-c", "ls"])
    expect(r.command).toBe("sh")
    expect(r.args).toEqual(["-c", "ls"])
  })

  test("注册包封 provider 换装", () => {
    const mock: SandboxProvider = {
      name: "mock-box",
      wrap: (_cmd, args) => ({ command: "firejail", args: ["--", ...args] }),
    }
    const unsub = capabilityRegistry.register("sandbox", mock)
    expect(getSandbox().name).toBe("mock-box")
    const r = getSandbox().wrap("sh", ["-c", "ls"])
    expect(r.command).toBe("firejail")
    unsub()
    expect(getSandbox().name).toBe("none")
  })
})
