/**
 * Web 页面生成工具 — Interactive 交互组件（HTML + JS）
 * 生成可交互的单文件 HTML 页面（.html）：可点选切换、滑块、表单、状态机、数据可视化（canvas）等。
 * 交付为独立 .html 文件，用户可用浏览器打开。
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

export const createWebpageTool = make({
  name: "create_webpage",
  description: "Create an interactive HTML page (.html) with embedded CSS and JavaScript. Supports: clickable tabs, sliders, forms, charts (canvas), interactive components, single-page apps. Use when: user wants interactive content, data dashboards, clickable prototypes, form widgets, mini web apps. IMPORTANT: only use this tool when an interactive .html page is truly required — for static SVG illustrations, flowcharts, diagrams, or cover art, output the SVG inside a ```svg fenced code block in your reply instead (the app renders a live preview).",
  inputSchema: z.object({
    path: z.string().describe("Output file path (absolute or relative to workspace), should end with .html"),
    title: z.string().optional().describe("Page title"),
    body: z.string().describe("HTML body content (can include HTML tags, forms, divs)"),
    scripts: z.string().optional().describe("JavaScript code (optional, runs in browser)"),
    styles: z.string().optional().describe("CSS styles (optional)"),
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
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${input.title || "Mira Interactive Page"}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: #f8f9fa; color: #1a1a2e; }
    ${input.styles || ""}
  </style>
</head>
<body>
${input.body || ""}
${input.scripts ? `<script>\n${input.scripts}\n</script>` : ""}
</body>
</html>`

      await getFs().mkdir(path.dirname(resolved), true)
      await getFs().writeFile(resolved, html)

      return {
        success: true,
        output: `Created ${resolved}\nInteractive HTML page with ${input.scripts ? "JavaScript" : "no scripts"}, ${input.styles ? "custom CSS" : "default styles"}`,
        metadata: { hasScripts: !!input.scripts, hasStyles: !!input.styles },
      }
    } catch (e) {
      return { success: false, error: `HTML 页面生成失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})
