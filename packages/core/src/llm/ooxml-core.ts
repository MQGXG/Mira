/**
 * Core 端 Office 解析（Node 环境，供发送时一次性注入）
 *
 * - Excel（xlsx）→ CSV 表格文本（含多 sheet）
 * - Word（docx）→ 段落 + 表格（Markdown 表格）
 * - PPT（pptx）→ 各幻灯片文本 + 表格
 *
 * 仅提取可读文本供模型理解；文档内嵌图片不提取（非核心需求）。
 */

import * as fs from "fs"
import { DOMParser } from "@xmldom/xmldom"

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml")
}

function textOf(node: Element | null): string {
  if (!node) return ""
  return (node.textContent || "").replace(/\s+/g, " ").trim()
}

/** 解析 .docx 文件 → 文本内容 */
async function docxToText(filePath: string): Promise<string> {
  const JSZip = (await import("jszip")).default
  const buffer = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(buffer)
  const docFile = zip.files["word/document.xml"]
  if (!docFile) return "（无法读取 Word 文档内容）"
  const xml = await docFile.async("string")
  const doc = parseXml(xml)
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0]
  if (!body) return ""

  const parts: string[] = []
  for (const node of Array.from(body.childNodes)) {
    const el = node as Element
    if (el.nodeType !== 1) continue // 跳过文本节点
    if (el.localName === "p") {
      const text = textOf(el)
      if (text) parts.push(text)
    } else if (el.localName === "tbl") {
      parts.push(docxTableToMarkdown(el))
    }
  }
  return parts.join("\n\n")
}

function docxTableToMarkdown(tbl: Element): string {
  const rows: string[][] = []
  const trs = tbl.getElementsByTagNameNS(W_NS, "tr")
  for (const tr of Array.from(trs)) {
    const cells: string[] = []
    const tcs = tr.getElementsByTagNameNS(W_NS, "tc")
    for (const tc of Array.from(tcs)) {
      cells.push(textOf(tc).replace(/\|/g, "\\|"))
    }
    rows.push(cells)
  }
  if (rows.length === 0) return ""
  const header = rows[0]
  const sep = header.map(() => "---")
  const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`)
  return [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...body].join("\n")
}

/** 解析 .pptx 文件 → 文本内容 */
async function pptxToText(filePath: string): Promise<string> {
  const JSZip = (await import("jszip")).default
  const buffer = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(buffer)
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)![1], 10) - parseInt(b.match(/slide(\d+)/)![1], 10))

  const slides: string[] = []
  for (const slidePath of slidePaths) {
    const xml = await zip.files[slidePath].async("string")
    const doc = parseXml(xml)
    const texts: string[] = []
    const tEls = doc.getElementsByTagNameNS(A_NS, "t")
    for (const t of Array.from(tEls)) {
      const text = (t.textContent || "").trim()
      if (text) texts.push(text)
    }
    const tables: string[] = []
    const tblEls = doc.getElementsByTagNameNS(A_NS, "tbl")
    for (const tbl of Array.from(tblEls)) {
      tables.push(drawingTableToMarkdown(tbl))
    }
    slides.push([...texts, ...tables].join("\n\n"))
  }
  return slides.map((s, i) => `## 幻灯片 ${i + 1}\n\n${s}`).join("\n\n")
}

function drawingTableToMarkdown(tbl: Element): string {
  const rows: string[][] = []
  const trs = tbl.getElementsByTagNameNS(A_NS, "tr")
  for (const tr of Array.from(trs)) {
    const cells: string[] = []
    const tcs = tr.getElementsByTagNameNS(A_NS, "tc")
    for (const tc of Array.from(tcs)) {
      cells.push(textOf(tc).replace(/\|/g, "\\|"))
    }
    rows.push(cells)
  }
  if (rows.length === 0) return ""
  const header = rows[0]
  const sep = header.map(() => "---")
  const body = rows.slice(1).map((r) => `| ${r.join(" | ")} |`)
  return [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`, ...body].join("\n")
}

/** 解析 .xlsx 文件 → CSV 文本 */
async function xlsxToText(filePath: string): Promise<string> {
  const XLSX = await import("xlsx")
  const buffer = fs.readFileSync(filePath)
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    const csv = XLSX.utils.sheet_to_csv(ws)
    parts.push(`## 工作表：${name}\n\n${csv}`)
  }
  return parts.join("\n\n")
}

/**
 * 按扩展名解析 Office 文件为文本（供模型理解）。
 * 失败返回 null（由调用方决定降级提示）。
 */
export async function parseOfficeFileForModel(filePath: string, fileName: string): Promise<string | null> {
  const ext = fileName.toLowerCase().split(".").pop() || ""
  try {
    if (ext === "docx") return await docxToText(filePath)
    if (ext === "pptx") return await pptxToText(filePath)
    if (["xlsx", "xls", "xlsm", "ods"].includes(ext)) return await xlsxToText(filePath)
  } catch { /* 解析失败 */ }
  return null
}
