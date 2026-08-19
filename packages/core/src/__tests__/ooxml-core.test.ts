import { describe, it, expect, beforeAll, afterAll } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType } from "docx"
import { parseOfficeFileForModel } from "../llm/ooxml-core"

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ooxml-test-"))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function makeDocx(paragraphs: string[]): Promise<string> {
  const doc = new Document({
    sections: [{
      children: paragraphs.map((t) => new Paragraph({ children: [new TextRun(t)] })),
    }],
  })
  const buffer = await Packer.toBuffer(doc)
  const filePath = path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.docx`)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

async function makeDocxWithTable(): Promise<string> {
  const doc = new Document({
    sections: [{
      children: [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun("A1")] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun("B1")] })] }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun("A2")] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun("B2")] })] }),
              ],
            }),
          ],
        }),
      ],
    }],
  })
  const buffer = await Packer.toBuffer(doc)
  const filePath = path.join(tmpDir, `test-tbl-${Date.now()}.docx`)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

describe("parseOfficeFileForModel", () => {
  it("解析 docx 纯文本段落", async () => {
    const filePath = await makeDocx(["Hello World", "Second paragraph"])
    const result = await parseOfficeFileForModel(filePath, "test.docx")
    expect(result).toBeTruthy()
    expect(result).toContain("Hello World")
    expect(result).toContain("Second paragraph")
  })

  it("解析 docx 表格为 Markdown 表格", async () => {
    const filePath = await makeDocxWithTable()
    const result = await parseOfficeFileForModel(filePath, "tbl.docx")
    expect(result).toBeTruthy()
    expect(result).toContain("| A1 | B1 |")
    expect(result).toContain("| --- | --- |")
    expect(result).toContain("A2")
  })

  it("不支持的格式返回 null", async () => {
    const result = await parseOfficeFileForModel("/nonexistent/file.xyz", "file.xyz")
    expect(result).toBeNull()
  })

  it("文件不存在返回 null", async () => {
    const result = await parseOfficeFileForModel("/nonexistent/missing.docx", "missing.docx")
    expect(result).toBeNull()
  })
})
