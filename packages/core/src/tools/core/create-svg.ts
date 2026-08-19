/**
 * SVG 插画工具 — Art（SVG 插画/装饰视觉）
 * 生成概念封面、抽象意象、装饰性 SVG 图形：渐变背景、几何图形、线条艺术、图标组合等。
 */

import { z } from "zod"
import { make } from "../../shared/tool"

function escapeXml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** 生成渐变背景 + 几何图形的抽象 SVG 插画 */
function generateArt(style: string, title: string, width: number, height: number): string {
  const shapes: string[] = []
  const palette = ["#6366f1", "#a855f7", "#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#ec4899"]

  // 圆环
  for (let i = 0; i < 4; i++) {
    const cx = width * (0.15 + i * 0.23)
    const cy = height * (0.2 + (i % 2) * 0.5)
    const r = 30 + i * 18
    shapes.push(`<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r}" fill="none" stroke="${palette[i % palette.length]}" stroke-width="2" opacity="0.7"/>`)
  }

  // 圆点
  for (let i = 0; i < 8; i++) {
    const x = width * (0.1 + Math.random() * 0.8)
    const y = height * (0.1 + Math.random() * 0.8)
    const r = 3 + Math.random() * 6
    shapes.push(`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${palette[i % palette.length]}" opacity="0.5"/>`)
  }

  // 三角形（金字塔感）
  shapes.push(`<polygon points="${width * 0.7},${height * 0.15} ${width * 0.85},${height * 0.45} ${width * 0.55},${height * 0.45}" fill="none" stroke="${palette[1]}" stroke-width="2" opacity="0.6"/>`)

  // 渐变标题背景条
  shapes.push(`<rect x="${width * 0.2}" y="${height * 0.75}" width="${width * 0.6}" height="${height * 0.08}" rx="8" fill="url(#miraGrad)" opacity="0.2"/>`)

  const defs = style === "gradient"
    ? `<defs>
      <linearGradient id="miraGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#6366f1"/>
        <stop offset="50%" stop-color="#a855f7"/>
        <stop offset="100%" stop-color="#06b6d4"/>
      </linearGradient>
    </defs>`
    : ""

  const bg = style === "gradient"
    ? `<rect width="${width}" height="${height}" fill="url(#miraGrad)" opacity="0.08" rx="12"/>`
    : `<rect width="${width}" height="${height}" fill="#ffffff" rx="12"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${defs}
  ${bg}
  ${shapes.join("\n")}
  <text x="${width / 2}" y="${height * 0.85}" text-anchor="middle" font-size="22" font-weight="bold" fill="#1a1a2e">${escapeXml(title)}</text>
  </svg>`
}

export const createSvgTool = make({
  name: "create_svg",
  description: "Create an abstract SVG illustration / cover art. Generates gradient backgrounds, geometric shapes, decorative patterns, concept covers. Use when: user wants visual covers, abstract images, decorative graphics, concept illustrations, brand visuals. IMPORTANT: after generating, output the SVG in your reply inside a ```svg fenced code block so the app renders a live preview below the source code.",
  inputSchema: z.object({
    title: z.string().optional().describe("Text to include in the illustration"),
    style: z.enum(["gradient", "minimal"]).optional().describe("Style: gradient (彩色渐变) or minimal (简洁)，默认 gradient"),
    width: z.number().optional().describe("Canvas width (px)，默认 800"),
    height: z.number().optional().describe("Canvas height (px)，默认 500"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    try {
      const svg = generateArt(input.style || "gradient", input.title || "", input.width || 800, input.height || 500)
      return { success: true, output: svg, metadata: { type: "svg", style: input.style || "gradient" } }
    } catch (e) {
      return { success: false, error: `SVG 生成失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})
