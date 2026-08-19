import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"
import { getFs } from "../../capability/fs"
import { make, type Content } from "../../shared/tool"
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, TableRow, TableCell, Table, WidthType, TableOfContents } from "docx"

async function realPath(p: string): Promise<string> {
  try { return await fs.realpath(p) } catch { return p }
}

function contains(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return !rel.startsWith("..") && !path.isAbsolute(rel)
}

interface DocxContent {
  type: "paragraph" | "heading" | "table" | "bullet" | "numbered"
  text?: string
  level?: number
  bold?: boolean
  italic?: boolean
  alignment?: "left" | "center" | "right" | "justify"
  rows?: string[][]
}

export const createDocxTool = make({
  name: "create_docx",
  description: "Create a Word document (.docx) with formatted content. Supports headings, paragraphs, tables, and lists. Use when: user says '整理成文档'/'生成报告'/'做成Word', exporting content to document format, creating formatted reports.",
  inputSchema: z.object({
    path: z.string().describe("Output file path (absolute or relative to workspace)"),
    title: z.string().optional().describe("Document title"),
    content: z.array(z.object({
      type: z.enum(["paragraph", "heading", "table", "bullet", "numbered"]).describe("Content type"),
      text: z.string().optional().describe("Text content for paragraph/heading/bullet/numbered"),
      level: z.number().optional().describe("Heading level (1-6) for heading type"),
      bold: z.boolean().optional().describe("Bold text"),
      italic: z.boolean().optional().describe("Italic text"),
      alignment: z.enum(["left", "center", "right", "justify"]).optional().describe("Text alignment"),
      rows: z.array(z.array(z.string())).optional().describe("Table rows as array of arrays"),
    })).describe("Document content structure"),
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
      // 构建文档内容
      const sections: (Paragraph | Table)[] = []

      // 添加标题（如果有）
      if (input.title) {
        sections.push(
          new Paragraph({
            children: [
              new TextRun({
                text: input.title,
                bold: true,
                size: 32, // 16pt
              }),
            ],
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
          })
        )
      }

      // 处理内容
      for (const item of input.content) {
        switch (item.type) {
          case "heading": {
            const level = Math.min(Math.max(item.level || 1, 1), 6)
            const headingLevel = [
              HeadingLevel.HEADING_1,
              HeadingLevel.HEADING_2,
              HeadingLevel.HEADING_3,
              HeadingLevel.HEADING_4,
              HeadingLevel.HEADING_5,
              HeadingLevel.HEADING_6,
            ][level - 1]

            sections.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: item.text || "",
                    bold: true,
                  }),
                ],
                heading: headingLevel,
                spacing: { before: 240, after: 120 },
              })
            )
            break
          }

          case "paragraph": {
            const alignmentMap = {
              left: AlignmentType.LEFT,
              center: AlignmentType.CENTER,
              right: AlignmentType.RIGHT,
              justify: AlignmentType.JUSTIFIED,
            }

            sections.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: item.text || "",
                    bold: item.bold,
                    italics: item.italic,
                  }),
                ],
                alignment: item.alignment ? alignmentMap[item.alignment] : AlignmentType.LEFT,
                spacing: { after: 200 },
              })
            )
            break
          }

          case "table": {
            if (item.rows && item.rows.length > 0) {
              const tableRows = item.rows.map((row, rowIndex) =>
                new TableRow({
                  children: row.map((cell) =>
                    new TableCell({
                      children: [
                        new Paragraph({
                          children: [
                            new TextRun({
                              text: cell,
                              bold: rowIndex === 0, // 第一行加粗（表头）
                            }),
                          ],
                        }),
                      ],
                      width: {
                        size: Math.floor(100 / row.length),
                        type: WidthType.PERCENTAGE,
                      },
                    })
                  ),
                })
              )

              sections.push(
                new Table({
                  rows: tableRows,
                  width: {
                    size: 100,
                    type: WidthType.PERCENTAGE,
                  },
                })
              )

              // 表格后添加空行
              sections.push(new Paragraph({ children: [] }))
            }
            break
          }

          case "bullet": {
            sections.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: item.text || "",
                  }),
                ],
                bullet: { level: 0 },
                spacing: { after: 100 },
              })
            )
            break
          }

          case "numbered": {
            sections.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: item.text || "",
                  }),
                ],
                numbering: { reference: "numbering", level: 0 },
                spacing: { after: 100 },
              })
            )
            break
          }
        }
      }

      // 如果没有内容，添加一个空段落
      if (sections.length === 0) {
        sections.push(new Paragraph({ children: [] }))
      }

      // 创建文档
      const doc = new Document({
        sections: [
          {
            properties: {},
            children: sections,
          },
        ],
        numbering: {
          config: [
            {
              reference: "numbering",
              levels: [
                {
                  level: 0,
                  format: "decimal",
                  text: "%1.",
                  alignment: AlignmentType.LEFT,
                },
              ],
            },
          ],
        },
      })

      // 生成文档
      const buffer = await Packer.toBuffer(doc)

      // 确保目录存在
      await getFs().mkdir(path.dirname(resolved), true)

      // 写入文件
      await getFs().writeFile(resolved, buffer)

      return {
        success: true,
        output: `Word document created: ${resolved} (${buffer.length} bytes)`,
      }
    } catch (error: any) {
      return {
        success: false,
        error: `Failed to create Word document: ${error.message}`,
      }
    }
  },
})

