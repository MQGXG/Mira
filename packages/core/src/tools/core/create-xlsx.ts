/**
 * Excel 生成工具 — 使用 SheetJS (xlsx) 库
 * 生成 .xlsx 电子表格，支持多工作表、表头样式、单元格数据。
 */

import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"
import { getFs } from "../../capability/fs"
import { make, type Content } from "../../shared/tool"

async function realPath(p: string): Promise<string> {
  try { return await fs.realpath(p) } catch { return p }
}

function contains(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** 单元格值：字符串/数字/布尔/公式 */
const CellValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const createXlsxTool = make({
  name: "create_xlsx",
  description: "Create an Excel spreadsheet (.xlsx) with multiple sheets, headers, and tabular data. Use when: user says '做成Excel'/'生成表格'/'导出为xlsx'/'制作电子表格', exporting data to spreadsheet format, creating data reports.",
  inputSchema: z.object({
    path: z.string().describe("Output file path (absolute or relative to workspace)"),
    sheets: z.array(z.object({
      name: z.string().describe("Sheet name (e.g. '销售数据', 'Sheet1')"),
      headers: z.array(z.string()).optional().describe("Column headers (first row)"),
      rows: z.array(z.array(CellValue)).describe("Data rows (each row is an array of cell values)"),
    })).describe("One or more sheets to create"),
  }),
  outputSchema: z.string(),
  permission: "edit",
  toModelOutput(input, output): Content[] {
    return [{ type: "text", text: typeof output === "string" ? output : "" }]
  },
  async execute(input, ctx) {
    const absolute = path.resolve(ctx.workspace, input.path)
    if (!path.isAbsolute(input.path) && !contains(ctx.workspace, absolute)) {
      return { success: false, error: `Path escapes workspace: ${input.path}` }
    }
    const root = await realPath(ctx.workspace)
    const resolved = path.resolve(root, input.path)
    if (!contains(root, resolved)) {
      return { success: false, error: `Path escapes workspace after symlink resolution: ${input.path}` }
    }

    try {
      const XLSX = await import("xlsx")
      const workbook = XLSX.utils.book_new()

      for (const sheet of input.sheets) {
        // 构建 2D 数组：headers + rows
        const aoa: (string | number | boolean | null)[][] = []
        if (sheet.headers && sheet.headers.length > 0) {
          aoa.push(sheet.headers)
        }
        aoa.push(...sheet.rows.map((r) => r.map((v) => v ?? "")))

        const ws = XLSX.utils.aoa_to_sheet(aoa)

        // 设置列宽（根据 header 长度粗略估算）
        if (sheet.headers) {
          ws["!cols"] = sheet.headers.map((h) => ({ wch: Math.max(h.length + 2, 10) }))
        }

        XLSX.utils.book_append_sheet(workbook, ws, sheet.name)
      }

      // 确保目录存在
      await getFs().mkdir(path.dirname(resolved), true)

      // 写入文件
      XLSX.writeFile(workbook, resolved)

      const sheetInfo = input.sheets.map((s) => `${s.name}(${s.rows.length}行)`).join(", ")
      return {
        success: true,
        output: `Created ${resolved}\nSheets: ${sheetInfo}\nTotal rows: ${input.sheets.reduce((sum, s) => sum + s.rows.length, 0)}`,
        metadata: { sheets: input.sheets.length, totalRows: input.sheets.reduce((sum, s) => sum + s.rows.length, 0) },
      }
    } catch (e) {
      return { success: false, error: `Excel 生成失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})
