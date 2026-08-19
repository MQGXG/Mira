import { describe, it, expect } from "vitest"
import { detectDoomLoop, detectTextNgramRepeat, checkOverflow } from "../agent/utils"
import type { LLMMessage } from "../llm/client"

const t = (name: string, args = "{}") => ({ name, args })

describe("detectDoomLoop — 模式1: 精确重复", () => {
  it("连续 3 次相同工具+相同参数 → 检测", () => {
    const recent = [t("grep", "foo"), t("grep", "foo"), t("grep", "foo")]
    expect(detectDoomLoop({ name: "grep", args: "foo" }, recent)).toBe(true)
  })

  it("参数不同不触发精确重复", () => {
    const recent = [t("grep", "1"), t("bash", "2"), t("grep", "3")]
    expect(detectDoomLoop({ name: "grep", args: "4" }, recent)).toBe(false)
  })

  it("不足 3 次不检测", () => {
    const recent = [t("grep", "foo"), t("grep", "foo")]
    expect(detectDoomLoop({ name: "grep", args: "foo" }, recent)).toBe(false)
  })
})

describe("detectDoomLoop — 模式2: 同工具风暴", () => {
  it("连续 4 次同一工具（参数不同）→ 检测", () => {
    const recent = [t("read_file", "a.ts"), t("read_file", "b.ts"), t("read_file", "c.ts")]
    expect(detectDoomLoop({ name: "read_file", args: "d.ts" }, recent)).toBe(true)
  })

  it("连续 3 次不检测", () => {
    const recent = [t("read_file", "a.ts"), t("read_file", "b.ts")]
    expect(detectDoomLoop({ name: "read_file", args: "c.ts" }, recent)).toBe(false)
  })
})

describe("detectDoomLoop — 模式3: 读-写空转", () => {
  it("read→write 循环 ≥2 次 → 检测", () => {
    const recent = [t("read_file", "a"), t("write_file", "a"), t("read_file", "b"), t("bash", "b")]
    expect(detectDoomLoop({ name: "read_file", args: "c" }, recent)).toBe(true)
  })

  it("单次读-写不检测", () => {
    const recent = [t("read_file", "a"), t("write_file", "a")]
    expect(detectDoomLoop({ name: "read_file", args: "c" }, recent)).toBe(false)
  })
})

describe("detectTextNgramRepeat", () => {
  it("重复文本检测", () => {
    const text = "abcabcabcabcabcabc" // 3-gram "abc" 大量重复
    expect(detectTextNgramRepeat(text, 3)).toBe(true)
  })

  it("正常文本不检测", () => {
    expect(detectTextNgramRepeat("The quick brown fox jumps over the lazy dog.", 3)).toBe(false)
  })

  it("过短文本不检测", () => {
    expect(detectTextNgramRepeat("ab", 3)).toBe(false)
  })
})

describe("checkOverflow", () => {
  const msg = (content: string): LLMMessage => ({ role: "user", content })

  it("超过阈值 → true", () => {
    const messages = [msg("x".repeat(5000))]
    expect(checkOverflow(messages, 500, 0.8)).toBe(true)
  })

  it("未超阈值 → false", () => {
    const messages = [msg("short")]
    expect(checkOverflow(messages, 50000, 0.8)).toBe(false)
  })
})