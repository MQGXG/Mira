/**
 * PPT 生成工具 — 使用 pptxgenjs 库
 * 生成 .pptx 演示文稿，支持标题/正文/项目符号/表格/多张幻灯片。
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

/** 单张幻灯片内容 */
const SlideContent = z.object({
  title: z.string().optional().describe("Slide title"),
  bullets: z.array(z.string()).optional().describe("Bullet points"),
  paragraph: z.string().optional().describe("Paragraph text"),
  table: z.object({
    headers: z.array(z.string()).describe("Table column headers"),
    rows: z.array(z.array(z.union([z.string(), z.number()]))).describe("Table data rows"),
  }).optional().describe("Table data"),
})

export const createPptxTool = make({
  name: "create_pptx",
  description: "Create a PowerPoint presentation (.pptx) with multiple slides, titles, bullet points, and tables. Use when: user says '做成PPT'/'生成演示文稿'/'做幻灯片'/'做报告', creating presentations, slide decks, pitch decks.",
  inputSchema: z.object({
    path: z.string().describe("Output file path (absolute or relative to workspace)"),
    title: z.string().optional().describe("Presentation title (cover slide)"),
    subtitle: z.string().optional().describe("Presentation subtitle"),
    slides: z.array(SlideContent).describe("Slide content (each item is one slide)"),
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
      const pptxgen = (await import("pptxgenjs")).default
      const pptx = new pptxgen()

      // 封面页
      if (input.title) {
        const cover = pptx.addSlide()
        cover.background = { color: "1a1a2e" }
        cover.addText(input.title, {
          x: 0.5, y: 2.0, w: 9, h: 1.5,
          fontSize: 36, bold: true, color: "FFFFFF", align: "center",
        })
        if (input.subtitle) {
          cover.addText(input.subtitle, {
            x: 0.5, y: 3.5, w: 9, h: 1,
            fontSize: 18, color: "BBBBBB", align: "center",
          })
        }
      }

      // 内容幻灯片
      for (const slide of input.slides) {
        const s = pptx.addSlide()
        s.background = { color: "FFFFFF" }

        let y = 0.4
        if (slide.title) {
          s.addText(slide.title, {
            x: 0.5, y, w: 9, h: 0.8,
            fontSize: 28, bold: true, color: "333333",
          })
          y += 1.0
        }

        if (slide.bullets && slide.bullets.length > 0) {
          // pptxgenjs 支持逐行文本数组，每项一个 bullet
          s.addText(slide.bullets.map((b, i) => ({
            text: b,
            options: { bullet: { code: "2022", indent: 12 }, breakLine: i < slide.bullets!.length - 1 },
          })), {
            x: 0.5, y, w: 9, h: 5.0,
            fontSize: 16, color: "444444",
          })
        }

        if (slide.paragraph) {
          s.addText(slide.paragraph, {
            x: 0.5, y, w: 9, h: 4.5,
            fontSize: 16, color: "444444",
          })
        }

        if (slide.table) {
          const headers = slide.table.headers.map((h) => ({
            text: h, options: { bold: true, color: "FFFFFF", fill: { color: "6366F1" } },
          }))
          const rows = slide.table.rows.map((r) => r.map((v) => ({ text: String(v) })))
          s.addTable([headers, ...rows], {
            x: 0.5, y, w: 9, h: 4.5,
            border: { pt: 0.5, color: "DDDDDD" },
            fill: { color: "FFFFFF" },
          })
        }
      }

      // 写入文件
      await getFs().mkdir(path.dirname(resolved), true)
      await pptx.writeFile({ fileName: resolved })

      return {
        success: true,
        output: `Created ${resolved}\nSlides: ${(input.title ? 1 : 0) + input.slides.length} (含封面)`,
        metadata: { slides: input.slides.length, hasCover: !!input.title },
      }
    } catch (e) {
      return { success: false, error: `PPT 生成失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})
