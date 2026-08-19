/**
 * 界面原型图工具 — Mockup（SVG 线框图）
 * 生成界面布局线框图（wireframe）：导航栏、侧边栏、卡片、按钮、表单等，
 * 用于写代码前对齐布局。返回可内嵌的 SVG。
 */

import { z } from "zod"
import { make } from "../../shared/tool"

function escapeXml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

interface Element {
  type: "navbar" | "sidebar" | "card" | "button" | "input" | "text" | "image" | "chart" | "table"
  label?: string
  x?: number
  y?: number
  w?: number
  h?: number
  rows?: number
}

/** 生成界面线框图 SVG */
function generateMockup(width: number, height: number, title: string, elements: Element[]): string {
  const el = elements || []
  const parts: string[] = []

  for (const e of el) {
    const x = e.x ?? 0
    const y = e.y ?? 0
    const w = e.w ?? 100
    const h = e.h ?? 40
    const label = escapeXml(e.label || "")

    switch (e.type) {
      case "navbar":
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4,2"/>
          <text x="${x + 8}" y="${y + 22}" font-size="11" fill="#64748b">${label}</text>`)
        break
      case "sidebar":
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
          <text x="${x + 8}" y="${y + 18}" font-size="11" fill="#64748b">${label}</text>`)
        break
      case "card":
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
          <text x="${x + 8}" y="${y + 18}" font-size="11" fill="#475569">${label}</text>`)
        break
      case "button":
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#6366f1" opacity="0.15" stroke="#6366f1" stroke-width="1.2"/>
          <text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="11" fill="#6366f1">${label || "Button"}</text>`)
        break
      case "input":
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.2"/>
          <text x="${x + 8}" y="${y + 18}" font-size="10" fill="#94a3b8">${label || "输入框"}</text>`)
        break
      case "text":
        parts.push(`<text x="${x}" y="${y + 14}" font-size="${h || 14}" fill="#334155">${label}</text>`)
        break
      case "image":
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#e2e8f0" stroke="#94a3b8" stroke-width="1.2"/>
          <text x="${x + w / 2}" y="${y + h / 2 + 4}" text-anchor="middle" font-size="10" fill="#64748b">${label || "图片"}</text>`)
        break
      case "chart":
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.2"/>
          <text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" font-size="10" fill="#64748b">${label || "图表"}</text>`)
        break
      case "table": {
        const rows = e.rows || 3
        const rowH = h / rows
        parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.2"/>`)
        for (let i = 0; i < rows; i++) {
          parts.push(`<line x1="${x}" y1="${y + i * rowH}" x2="${x + w}" y2="${y + i * rowH}" stroke="#e2e8f0" stroke-width="1"/>`)
        }
        break
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#ffffff" rx="8"/>
  <rect x="0" y="0" width="${width}" height="32" fill="#f8fafc" rx="8"/>
  <text x="${width / 2}" y="22" text-anchor="middle" font-size="14" font-weight="bold" fill="#1a1a2e">${escapeXml(title)}</text>
  <g transform="translate(0, 40)">
  ${parts.join("\n")}
  </g>
  </svg>`
}

export const createMockupTool = make({
  name: "create_mockup",
  description: "Create a UI wireframe / mockup (SVG). Draws layout elements: navbar导航栏, sidebar侧边栏, card卡片, button按钮, input输入框, text文本, image图片占位, chart图表占位, table表格. Use when: user wants to design UI layout before coding, align on page structure, create app prototypes, wireframes.",
  inputSchema: z.object({
    title: z.string().optional().describe("Prototype title（默认：界面原型）"),
    width: z.number().optional().describe("Canvas width (px)，默认 800"),
    height: z.number().optional().describe("Canvas height (px)，默认 500"),
    elements: z.array(z.object({
      type: z.enum(["navbar", "sidebar", "card", "button", "input", "text", "image", "chart", "table"]).describe("Element type"),
      label: z.string().optional().describe("Element label"),
      x: z.number().optional().describe("X position"),
      y: z.number().optional().describe("Y position"),
      w: z.number().optional().describe("Width"),
      h: z.number().optional().describe("Height"),
      rows: z.number().optional().describe("Table rows (table type)"),
    })).describe("UI elements to draw"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    try {
      const svg = generateMockup(input.width || 800, input.height || 500, input.title || "界面原型", input.elements || [])
      return { success: true, output: svg, metadata: { type: "svg", elementCount: (input.elements || []).length } }
    } catch (e) {
      return { success: false, error: `原型生成失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})
