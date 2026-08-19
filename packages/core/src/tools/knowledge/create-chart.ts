/**
 * 图表生成工具 — 生成数据图表（SVG）和流程图（mermaid 语法）
 *
 * - 数据图表：bar/line/pie/area/scatter → 返回可内嵌的 SVG 字符串
 * - 流程图/时序图/状态图：flowchart/sequence/er/state → 返回 mermaid 代码块
 *   （UI 端 markdown 的 mermaid 插件自动渲染）
 *
 * 零外部依赖：SVG 手写生成；mermaid 只输出语法，由前端渲染。
 */

import { z } from "zod"
import { make } from "../../shared/tool"

// ── 数据图表（SVG 生成） ─────────────────────────────────

interface ChartPoint {
  label: string
  value: number
}

/** 数据校验：过滤非法值 */
function sanitizeData(data: ChartPoint[]): ChartPoint[] {
  return (data || [])
    .filter((d) => d && d.label != null && typeof d.value === "number" && !isNaN(d.value))
    .slice(0, 50)
}

/** 转义 XML 特殊字符 */
function escapeXml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** 生成柱状图 SVG */
function barChart(data: ChartPoint[], title: string): string {
  const w = 640, h = 380
  const ml = 60, mr = 20, mt = 50, mb = 60
  const cw = w - ml - mr, ch = h - mt - mb
  const max = Math.max(...data.map((d) => d.value), 1)
  const gap = cw / data.length
  const bw = Math.max(12, gap * 0.6)
  const palette = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#ec4899"]

  const bars = data.map((d, i) => {
    const bh = Math.max(2, (d.value / max) * ch)
    const x = ml + i * gap + (gap - bw) / 2
    const y = mt + ch - bh
    const c = palette[i % palette.length]
    return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="3" fill="${c}"><title>${escapeXml(d.label)}: ${d.value}</title></rect>
      <text x="${x + bw / 2}" y="${mt + ch + 18}" text-anchor="middle" font-size="10" fill="#888">${escapeXml(d.label)}</text>`
  }).join("\n")

  // Y 轴刻度
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const ty = mt + ch - t * ch
    const val = Math.round(max * t * 10) / 10
    return `<line x1="${ml}" y1="${ty}" x2="${ml - 5}" y2="${ty}" stroke="#555"/>
      <text x="${ml - 10}" y="${ty + 4}" text-anchor="end" font-size="10" fill="#888">${val}</text>`
  }).join("\n")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#fff" rx="8"/>
  <text x="${w / 2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#333">${escapeXml(title)}</text>
  <line x1="${ml}" y1="${mt + ch}" x2="${ml + cw}" y2="${mt + ch}" stroke="#999"/>
  ${ticks}
  ${bars}
  </svg>`
}

/** 生成折线图 SVG */
function lineChart(data: ChartPoint[], title: string): string {
  const w = 640, h = 380
  const ml = 60, mr = 20, mt = 50, mb = 60
  const cw = w - ml - mr, ch = h - mt - mb
  const max = Math.max(...data.map((d) => d.value), 1)
  const min = Math.min(...data.map((d) => d.value), 0)
  const range = Math.max(max - min, 1)
  const step = cw / Math.max(data.length - 1, 1)

  const points = data.map((d, i) => {
    const x = ml + i * step
    const y = mt + ch - ((d.value - min) / range) * ch
    return { x, y, label: d.label, value: d.value }
  })

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
  const area = `${path} L${points[points.length - 1].x},${mt + ch} L${points[0].x},${mt + ch} Z`
  const dots = points.map((p, i) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#6366f1">
    <title>${escapeXml(p.label)}: ${p.value}</title></circle>`).join("\n")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#fff" rx="8"/>
  <text x="${w / 2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#333">${escapeXml(title)}</text>
  <line x1="${ml}" y1="${mt + ch}" x2="${ml + cw}" y2="${mt + ch}" stroke="#999"/>
  <path d="${area}" fill="#6366f1" opacity="0.1"/>
  <path d="${path}" fill="none" stroke="#6366f1" stroke-width="2.5" stroke-linejoin="round"/>
  ${dots}
  ${points.length > 0 ? `<text x="${points[0].x}" y="${mt + ch + 18}" font-size="10" fill="#888">${escapeXml(points[0].label)}</text>` : ""}
  ${points.length > 0 ? `<text x="${points[points.length - 1].x}" y="${mt + ch + 18}" text-anchor="end" font-size="10" fill="#888">${escapeXml(points[points.length - 1].label)}</text>` : ""}
  </svg>`
}

/** 生成饼图 SVG */
function pieChart(data: ChartPoint[], title: string): string {
  const w = 520, h = 380
  const cx = 180, cy = 200, r = 130
  const total = data.reduce((s, d) => s + d.value, 0) || 1
  const palette = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7", "#ec4899", "#f97316"]

  let angle = -90
  const slices = data.map((d, i) => {
    const sweep = (d.value / total) * 360
    const sRad = (angle * Math.PI) / 180
    const eRad = ((angle + sweep) * Math.PI) / 180
    const x1 = cx + r * Math.cos(sRad)
    const y1 = cy + r * Math.sin(sRad)
    const x2 = cx + r * Math.cos(eRad)
    const y2 = cy + r * Math.sin(eRad)
    const large = sweep > 180 ? 1 : 0
    const c = palette[i % palette.length]
    angle += sweep
    return `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z" fill="${c}" stroke="#fff" stroke-width="1.5"><title>${escapeXml(d.label)}: ${d.value}</title></path>
      <rect x="${330}" y="${60 + i * 26}" width="14" height="14" rx="3" fill="${c}"/>
      <text x="${350}" y="${72 + i * 26}" font-size="11" fill="#555">${escapeXml(d.label)} (${Math.round((d.value / total) * 100)}%)</text>`
  }).join("\n")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#fff" rx="8"/>
  <text x="${w / 2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#333">${escapeXml(title)}</text>
  ${slices}
  </svg>`
}

/** 生成面积图 SVG */
function areaChart(data: ChartPoint[], title: string): string {
  const w = 640, h = 380
  const ml = 60, mr = 20, mt = 50, mb = 60
  const cw = w - ml - mr, ch = h - mt - mb
  const max = Math.max(...data.map((d) => d.value), 1)
  const step = cw / Math.max(data.length - 1, 1)

  const points = data.map((d, i) => ({
    x: ml + i * step,
    y: mt + ch - (d.value / max) * ch,
    label: d.label,
    value: d.value,
  }))

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
  const area = `${line} L${points[points.length - 1].x},${mt + ch} L${points[0].x},${mt + ch} Z`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#fff" rx="8"/>
  <text x="${w / 2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#333">${escapeXml(title)}</text>
  <line x1="${ml}" y1="${mt + ch}" x2="${ml + cw}" y2="${mt + ch}" stroke="#999"/>
  <path d="${area}" fill="#22c55e" opacity="0.25"/>
  <path d="${line}" fill="none" stroke="#22c55e" stroke-width="2.5"/>
  </svg>`
}

/** 生成散点图 SVG */
function scatterChart(data: ChartPoint[], title: string): string {
  const w = 640, h = 380
  const ml = 60, mr = 20, mt = 50, mb = 60
  const cw = w - ml - mr, ch = h - mt - mb
  const max = Math.max(...data.map((d) => d.value), 1)
  const step = cw / Math.max(data.length - 1, 1)

  const dots = data.map((d, i) => {
    const x = ml + i * step
    const y = mt + ch - (d.value / max) * ch
    return `<circle cx="${x}" cy="${y}" r="5" fill="#6366f1" opacity="0.8">
      <title>${escapeXml(d.label)}: ${d.value}</title></circle>`
  }).join("\n")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#fff" rx="8"/>
  <text x="${w / 2}" y="28" text-anchor="middle" font-size="15" font-weight="bold" fill="#333">${escapeXml(title)}</text>
  <line x1="${ml}" y1="${mt + ch}" x2="${ml + cw}" y2="${mt + ch}" stroke="#999"/>
  <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ch}" stroke="#999"/>
  ${dots}
  </svg>`
}

/** 根据图表类型生成 SVG */
function generateDataChart(chartType: string, data: ChartPoint[], title: string): string {
  const clean = sanitizeData(data)
  if (clean.length === 0) return "数据为空或格式无效"

  switch (chartType) {
    case "bar": return barChart(clean, title)
    case "line": return lineChart(clean, title)
    case "pie": return pieChart(clean, title)
    case "area": return areaChart(clean, title)
    case "scatter": return scatterChart(clean, title)
    default: return barChart(clean, title)
  }
}

// ── 流程图（mermaid 语法） ─────────────────────────────────

/**
 * 构建 mermaid 代码块
 * definition 可能已带类型头（如 "graph TD"）或只有内容（如 "TD\nA-->B"）
 */
function buildMermaidBlock(diagramType: string, definition: string): string {
  const def = definition.trim()
  if (!def) return "mermaid 定义为空"

  const typeNames = ["graph", "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram", "erDiagram", "gantt", "journey", "pie", "mindmap", "gitGraph"]
  // flowchart 的方向缩写（TD/LR/BT/RL 单独一行）
  const flowDirections = /^(TD|LR|BT|RL)\s*$/i
  const firstLine = def.split("\n")[0].trim()

  // 首行已包含 mermaid 类型头（如 "graph TD"、"sequenceDiagram"）→ 直接用
  if (typeNames.some((t) => firstLine.startsWith(t))) {
    return `\`\`\`mermaid\n${def}\n\`\`\``
  }

  // 首行是 flowchart 方向缩写（TD/LR）→ 补 flowchart 头
  if (flowDirections.test(firstLine)) {
    return `\`\`\`mermaid\nflowchart ${firstLine}\n${def.split("\n").slice(1).join("\n")}\n\`\`\``
  }

  // 否则补完整类型头
  const full = `${diagramType}\n${def}`
  return `\`\`\`mermaid\n${full}\n\`\`\``
}

// ── 工具定义 ─────────────────────────────────────────────

export const createChartTool = make({
  name: "create_chart",
  description: `生成图表和流程图。支持两种模式：
1. 数据图表（data + chart_type）：bar柱状图 / line折线图 / pie饼图 / area面积图 / scatter散点图，返回可内嵌的 SVG
2. 流程图（diagram_type + definition）：flowchart流程图 / sequence时序图 / er实体关系图 / state状态图，返回 mermaid 代码块（UI 自动渲染）
用于：数据可视化、流程说明、架构图、时序图、ER 图等。`,
  inputSchema: z.object({
    mode: z.enum(["data", "flowchart"]).optional().describe("图表模式：data=数据图表(SVG)，flowchart=流程图(mermaid)，默认 data"),
    chart_type: z.enum(["bar", "line", "pie", "area", "scatter"]).optional().describe("数据图表类型（mode=data 时使用，默认 bar）"),
    title: z.string().optional().describe("图表标题（默认：图表）"),
    data: z.array(z.object({
      label: z.string().describe("数据点标签"),
      value: z.number().describe("数据点数值"),
    })).optional().describe("数据点数组（mode=data 时使用）"),
    diagram_type: z.enum(["flowchart", "sequenceDiagram", "erDiagram", "stateDiagram", "classDiagram", "gantt"]).optional().describe("流程图类型（mode=flowchart 时使用，默认 flowchart）"),
    definition: z.string().optional().describe("mermaid 定义内容（mode=flowchart 时使用）。flowchart 示例: 'TD\\nA[开始] --> B[处理] --> C[结束]'；sequenceDiagram 示例: 'A->>B: 请求\\nB-->>A: 响应'；也可直接写完整头如 'graph LR\\nA --> B'"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    try {
      if (input.mode === "flowchart" || input.definition) {
        const block = buildMermaidBlock(input.diagram_type || "flowchart", input.definition || "")
        return {
          success: true,
          output: `${input.title || "流程图"}\n\n${block}`,
          metadata: { type: "mermaid", diagramType: input.diagram_type || "flowchart" },
        }
      }

      // 数据图表模式
      const data = sanitizeData(input.data || [])
      if (data.length === 0) {
        return { success: false, error: "data 数组为空。请提供 {label, value} 数据点" }
      }
      const svg = generateDataChart(input.chart_type || "bar", data, input.title || "图表")
      return {
        success: true,
        output: svg,
        metadata: { type: "svg", chartType: input.chart_type || "bar", dataPoints: data.length },
      }
    } catch (e) {
      return { success: false, error: `图表生成失败: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
})
