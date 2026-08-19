import { describe, it, expect } from "vitest"
import { buildSendContent } from "../attachment-picker-ui"
import type { PendingAttachment } from "../file-parser"

describe("buildSendContent", () => {
  it("分离图片为 images 数组", () => {
    const atts: PendingAttachment[] = [
      { kind: "image", name: "a.png", size: 100, data: "data:image/png;base64,AAA", path: "/tmp/a.png" },
      { kind: "image", name: "b.png", size: 200, data: "data:image/png;base64,BBB", path: "/tmp/b.png" },
    ]
    const result = buildSendContent(atts, "看看这些图")
    expect(result.images).toEqual(["data:image/png;base64,AAA", "data:image/png;base64,BBB"])
    expect(result.files).toHaveLength(0)
    expect(result.rejected).toHaveLength(0)
  })

  it("PDF 作为图片发送（视觉桥）", () => {
    const atts: PendingAttachment[] = [
      { kind: "pdf", name: "doc.pdf", size: 500, data: "data:application/pdf;base64,PDF", path: "/tmp/doc.pdf" },
    ]
    const result = buildSendContent(atts, "")
    expect(result.images).toEqual(["data:application/pdf;base64,PDF"])
  })

  it("文本/Excel/Word 存路径引用（files），不内联内容", () => {
    const atts: PendingAttachment[] = [
      { kind: "text", name: "note.md", size: 50, data: "", path: "/tmp/note.md" },
      { kind: "excel", name: "data.xlsx", size: 300, data: "", path: "/tmp/data.xlsx" },
      { kind: "word", name: "report.docx", size: 500, data: "", path: "/tmp/report.docx" },
    ]
    const result = buildSendContent(atts, "分析文件")
    expect(result.files).toHaveLength(3)
    expect(result.files[0]).toEqual({ name: "note.md", path: "/tmp/note.md", kind: "text" })
    expect(result.files[1]).toEqual({ name: "data.xlsx", path: "/tmp/data.xlsx", kind: "excel" })
    expect(result.files[2]).toEqual({ name: "report.docx", path: "/tmp/report.docx", kind: "word" })
    // displayText 只含用户输入 + 文件卡片标记，不含文件内容
    expect(result.displayText).toContain("分析文件")
    expect(result.displayText).toContain("note.md")
    expect(result.displayText).not.toContain("hello world")
    expect(result.images).toHaveLength(0)
  })

  it("无路径的文本文件仍进入 files（kind 保留）", () => {
    const atts: PendingAttachment[] = [
      { kind: "text", name: "readme.txt", size: 30, data: "", path: undefined },
    ]
    const result = buildSendContent(atts, "")
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBeUndefined()
  })

  it("不支持/解析失败的文件进入 rejected", () => {
    const atts: PendingAttachment[] = [
      { kind: "unknown", name: "x.zip", size: 10, data: "", error: "该文件类型暂不支持解析" },
      { kind: "word", name: "broken.docx", size: 20, data: "", error: "文档解析失败" },
    ]
    const result = buildSendContent(atts, "hi")
    expect(result.rejected).toHaveLength(2)
    expect(result.images).toHaveLength(0)
  })

  it("无附件时返回默认提示", () => {
    const result = buildSendContent([], "")
    expect(result.displayText).toBe("请查看以下内容：")
  })
})
