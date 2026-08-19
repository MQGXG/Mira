import { describe, it, expect } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beginDesktopRun, readLastRun, clearCrashMarker } from "../crash-evidence"

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mira-crash-"))
}

describe("崩溃证据（active-run 标记）", () => {
  it("beginDesktopRun 写入标记，markClean 后删除", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    const run = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0-test" })
    expect(fs.existsSync(statePath)).toBe(true)
    run.markClean()
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it("markClean 幂等（重复调用不抛错）", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    const run = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0-test" })
    run.markClean()
    run.markClean()
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it("markClean 在标记被其他进程覆盖后不删除（ownerId 保护）", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    const run = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0-test" })
    // 模拟另一进程接管并重写了标记（新 ownerId）
    const otherRun = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: 9999, version: "0.0.0" })
    // 旧进程的 markClean：ownerId 不匹配 → 不应删除（新标记保留）
    run.markClean()
    expect(fs.existsSync(statePath)).toBe(true)
    // 新进程的 markClean 可以正常删除
    otherRun.markClean()
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it("残留标记可被下次启动读取（模拟崩溃后场景）", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    // 第一次启动：写标记后"崩溃"（不 markClean）
    beginDesktopRun(statePath, { startedAt: "2026-08-20T00:00:00.000Z", pid: 1111, version: "0.0.0" })
    // 第二次启动：读到上次残留
    const second = beginDesktopRun(statePath, { startedAt: "2026-08-20T00:01:00.000Z", pid: 2222, version: "0.0.0" })
    expect(second.previousRun).toBeDefined()
    expect(second.previousRun !== undefined && "unreadable" in second.previousRun).toBe(false)
    if (second.previousRun && !("unreadable" in second.previousRun)) {
      expect(second.previousRun.pid).toBe(1111)
      expect(second.previousRun.startedAt).toBe("2026-08-20T00:00:00.000Z")
      expect(second.previousRun.version).toBe("0.0.0")
    }
  })

  it("无标记时 previousRun 为 undefined", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    const run = beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0" })
    expect(run.previousRun).toBeUndefined()
    run.markClean()
  })

  it("readLastRun 只读不改（供 main 进程使用）", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    beginDesktopRun(statePath, { startedAt: "2026-08-20T00:00:00.000Z", pid: 3333, version: "0.0.0" })
    const last = readLastRun(statePath)
    expect(last).toBeDefined()
    if (last && !("unreadable" in last)) expect(last.pid).toBe(3333)
    // 读取不改动标记
    expect(fs.existsSync(statePath)).toBe(true)
  })

  it("损坏的标记返回 unreadable 而非抛错", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{ not json", "utf8")
    const last = readLastRun(statePath)
    expect(last && "unreadable" in last).toBe(true)
  })

  it("clearCrashMarker 幂等删除标记", () => {
    const dir = freshDir()
    const statePath = path.join(dir, "runtime", "active-run.json")
    beginDesktopRun(statePath, { startedAt: new Date().toISOString(), pid: process.pid, version: "0.0.0-test" })
    clearCrashMarker(statePath)
    expect(fs.existsSync(statePath)).toBe(false)
    clearCrashMarker(statePath) // 再次调用不抛错
    clearCrashMarker(path.join(dir, "nonexistent", "active-run.json")) // 不存在不抛错
  })
})
