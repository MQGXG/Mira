/**
 * 数据分析工具 — 纯 JS 实现 CSV 解析 + SVG 图表生成
 * 零外部依赖，替代 Python pandas + matplotlib
 */

import { z } from "zod"
import { make } from "../../shared/tool"
import { readFileSync, existsSync } from "fs"

/** 简易 CSV 解析 */
function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return { headers: [], rows: [] }

  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""))
  const rows = lines.slice(1).map((line) => {
    const values: string[] = []
    let current = ""
    let inQuote = false
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; continue }
      if (ch === "," && !inQuote) { values.push(current.trim()); current = ""; continue }
      current += ch
    }
    values.push(current.trim())
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = values[i] || "" })
    return row
  })
  return { headers, rows }
}

/** 检测数值列 */
function getNumericColumns(headers: string[], rows: Record<string, string>[]): string[] {
  return headers.filter((h) => rows.some((r) => {
    const v = parseFloat(r[h])
    return !isNaN(v) && r[h].trim() !== ""
  }))
}

/** 生成 SVG 柱状图 */
function generateBarChart(data: { label: string; value: number }[], title: string): string {
  const width = 600, height = 350
  const margin = { top: 40, right: 20, bottom: 60, left: 60 }
  const chartW = width - margin.left - margin.right
  const chartH = height - margin.top - margin.bottom
  const maxVal = Math.max(...data.map((d) => d.value), 1)
  const barW = Math.max(10, chartW / data.length * 0.6)
  const gap = chartW / data.length

  const bars = data.map((d, i) => {
    const barH = (d.value / maxVal) * chartH
    const x = margin.left + i * gap + (gap - barW) / 2
    const y = margin.top + chartH - barH
    const color = `hsl(${(i * 30 + 200) % 360}, 60%, 50%)`
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="2">
        <title>${d.label}: ${d.value}</title>
      </rect>
      <text x="${x + barW / 2}" y="${margin.top + chartH + 15}" text-anchor="middle" font-size="10" fill="#999" transform="rotate(-30,${x + barW / 2},${margin.top + chartH + 15})">${d.label}</text>
      <text x="${x + barW / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="#ccc">${d.value}</text>
    `
  }).join("\n")

  return `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#1a1a2e" rx="8"/>
      <text x="${width / 2}" y="25" text-anchor="middle" font-size="14" font-weight="bold" fill="#eee">${title}</text>
      ${bars}
    </svg>`, "utf-8"
  ).toString("base64")}`
}

/** 生成 SVG 折线图 */
function generateLineChart(data: { label: string; value: number }[], title: string): string {
  const width = 600, height = 350
  const margin = { top: 40, right: 20, bottom: 50, left: 60 }
  const chartW = width - margin.left - margin.right
  const chartH = height - margin.top - margin.bottom
  const maxVal = Math.max(...data.map((d) => d.value), 1)
  const minVal = Math.min(...data.map((d) => d.value), 0)
  const range = maxVal - minVal || 1
  const stepX = data.length > 1 ? chartW / (data.length - 1) : chartW

  const points = data.map((d, i) => ({
    x: margin.left + i * stepX,
    y: margin.top + chartH - ((d.value - minVal) / range) * chartH,
  }))

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
  const dots = points.map((p, i) => `
    <circle cx="${p.x}" cy="${p.y}" r="4" fill="#6366f1" stroke="#fff" stroke-width="1">
      <title>${data[i].label}: ${data[i].value}</title>
    </circle>
  `).join("\n")

  return `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#1a1a2e" rx="8"/>
      <text x="${width / 2}" y="25" text-anchor="middle" font-size="14" font-weight="bold" fill="#eee">${title}</text>
      <path d="${linePath}" fill="none" stroke="#6366f1" stroke-width="2"/>
      ${dots}
      <text x="${margin.left}" y="${margin.top + chartH + 15}" font-size="10" fill="#999">${data[0]?.label || ""}</text>
      <text x="${margin.left + chartW}" y="${margin.top + chartH + 15}" text-anchor="end" font-size="10" fill="#999">${data[data.length - 1]?.label || ""}</text>
    </svg>`, "utf-8"
  ).toString("base64")}`
}

/** 生成 SVG 饼图 */
function generatePieChart(data: { label: string; value: number }[], title: string): string {
  const width = 400, height = 350
  const cx = 160, cy = 180, r = 120
  const total = data.reduce((s, d) => s + d.value, 0) || 1

  const colors = ["#6366f1", "#ef4444", "#22c55e", "#f59e0b", "#06b6d4", "#a855f7", "#ec4899"]
  let currentAngle = -90
  const slices = data.map((d, i) => {
    const angle = (d.value / total) * 360
    const startRad = (currentAngle * Math.PI) / 180
    const endRad = ((currentAngle + angle) * Math.PI) / 180
    const x1 = cx + r * Math.cos(startRad)
    const y1 = cy + r * Math.sin(startRad)
    const x2 = cx + r * Math.cos(endRad)
    const y2 = cy + r * Math.sin(endRad)
    const large = angle > 180 ? 1 : 0
    const color = colors[i % colors.length]
    const path = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`
    const labelAngle = currentAngle + angle / 2
    const lx = cx + (r * 0.65) * Math.cos((labelAngle * Math.PI) / 180)
    const ly = cy + (r * 0.65) * Math.sin((labelAngle * Math.PI) / 180)
    currentAngle += angle
    return `<path d="${path}" fill="${color}" stroke="#1a1a2e" stroke-width="2"><title>${d.label}: ${d.value}</title></path>
      <text x="${lx}" y="${ly}" text-anchor="middle" font-size="10" fill="#fff">${Math.round(d.value / total * 100)}%</text>`
  }).join("\n")

  const legend = data.map((d, i) => `
    <rect x="290" y="${50 + i * 22}" width="12" height="12" fill="${colors[i % colors.length]}" rx="2"/>
    <text x="308" y="${60 + i * 22}" font-size="11" fill="#ccc">${d.label}</text>
  `).join("\n")

  return `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="${width}" height="${height}" fill="#1a1a2e" rx="8"/>
      <text x="${width / 2}" y="25" text-anchor="middle" font-size="13" font-weight="bold" fill="#eee">${title}</text>
      ${slices}
      ${legend}
    </svg>`, "utf-8"
  ).toString("base64")}`
}

export const dataAnalysisTool = make({
  name: "data_analysis",
  description: "分析数据（CSV）、生成统计图表。支持 summary/correlation/trend/distribution 分析类型，bar/line/pie 图表类型",
  inputSchema: z.object({
    data_source: z.string().describe("数据源：文件路径或 CSV 文本内容"),
    analysis_type: z.enum(["summary", "correlation", "trend", "distribution"]).optional().default("summary").describe("分析类型"),
    chart_type: z.enum(["bar", "line", "pie"]).optional().default("bar").describe("图表类型"),
  }),
  outputSchema: z.string(),
  execute: async (input) => {
    try {
      let csvText = input.data_source
      // 如果是文件路径则读取文件
      if (existsSync(input.data_source)) {
        csvText = readFileSync(input.data_source, "utf-8")
      }
      const { headers, rows } = parseCSV(csvText)
      if (rows.length === 0) {
        return { success: false, error: "CSV 数据为空或格式错误" }
      }
      const numericCols = getNumericColumns(headers, rows)

      let result = ""
      let chartData: { label: string; value: number }[] = []

      if (input.analysis_type === "summary") {
        const lines = [`## 数据概览`]
        lines.push(`- 总行数: ${rows.length}`)
        lines.push(`- 列: ${headers.join(", ")}`)
        lines.push(`- 数值列: ${numericCols.join(", ") || "无"}`)
        lines.push(``)
        for (const col of numericCols) {
          const vals = rows.map((r) => parseFloat(r[col])).filter((v) => !isNaN(v))
          if (vals.length === 0) continue
          const sum = vals.reduce((a, b) => a + b, 0)
          lines.push(`### ${col}`)
          lines.push(`- 均值: ${(sum / vals.length).toFixed(2)}`)
          lines.push(`- 最小: ${Math.min(...vals).toFixed(2)}`)
          lines.push(`- 最大: ${Math.max(...vals).toFixed(2)}`)
          lines.push(`- 总和: ${sum.toFixed(2)}`)
          lines.push(``)
        }
        result = lines.join("\n")

        // 取第一组数值列作图表
        if (numericCols.length > 0) {
          chartData = rows.slice(0, 20).map((r) => ({
            label: r[headers[0]] || rows.indexOf(r).toString(),
            value: parseFloat(r[numericCols[0]]) || 0,
          }))
        }
      } else if (input.analysis_type === "correlation") {
        if (numericCols.length < 2) {
          result = "需要至少 2 个数值列才能做相关性分析"
        } else {
          const lines = ["## 相关性矩阵"]
          for (let i = 0; i < numericCols.length; i++) {
            for (let j = i + 1; j < numericCols.length; j++) {
              const vals1 = rows.map((r) => parseFloat(r[numericCols[i]])).filter((v) => !isNaN(v))
              const vals2 = rows.map((r) => parseFloat(r[numericCols[j]])).filter((v) => !isNaN(v))
              const n = Math.min(vals1.length, vals2.length)
              const mean1 = vals1.slice(0, n).reduce((a, b) => a + b, 0) / n
              const mean2 = vals2.slice(0, n).reduce((a, b) => a + b, 0) / n
              let cov = 0, std1 = 0, std2 = 0
              for (let k = 0; k < n; k++) {
                const d1 = vals1[k] - mean1
                const d2 = vals2[k] - mean2
                cov += d1 * d2
                std1 += d1 * d1
                std2 += d2 * d2
              }
              const corr = std1 && std2 ? cov / Math.sqrt(std1 * std2) : 0
              lines.push(`- ${numericCols[i]} ↔ ${numericCols[j]}: ${corr.toFixed(3)}`)
            }
          }
          result = lines.join("\n")
        }
        // 散点图数据
        if (numericCols.length >= 2) {
          chartData = rows.slice(0, 50).map((r) => ({
            label: r[headers[0]] || rows.indexOf(r).toString(),
            value: parseFloat(r[numericCols[1]]) || 0,
          }))
        }
      } else if (input.analysis_type === "trend") {
        result = `## 趋势分析\n数据共 ${rows.length} 行，${headers.length} 列。\n\n数据范围: ${rows[0]?.[headers[0]] || "?"} → ${rows[rows.length - 1]?.[headers[0]] || "?"}`
        if (numericCols.length > 0) {
          chartData = rows.map((r) => ({
            label: r[headers[0]] || rows.indexOf(r).toString(),
            value: parseFloat(r[numericCols[0]]) || 0,
          }))
        }
      } else {
        result = `## 分布分析\n数据共 ${rows.length} 行`
        if (numericCols.length > 0) {
          const vals = rows.map((r) => parseFloat(r[numericCols[0]])).filter((v) => !isNaN(v))
          const bins = 10
          const min = Math.min(...vals), max = Math.max(...vals)
          const binSize = (max - min) / bins || 1
          const histogram = Array(bins).fill(0)
          for (const v of vals) {
            const idx = Math.min(Math.floor((v - min) / binSize), bins - 1)
            histogram[idx]++
          }
          chartData = histogram.map((count, i) => ({
            label: `${(min + i * binSize).toFixed(1)}`,
            value: count,
          }))
        }
      }

      // 生成图表
      let chartImg = ""
      if (chartData.length > 0) {
        if (input.chart_type === "pie") {
          chartImg = generatePieChart(chartData, `图表: ${input.analysis_type}`)
        } else if (input.chart_type === "line") {
          chartImg = generateLineChart(chartData, `图表: ${input.analysis_type}`)
        } else {
          chartImg = generateBarChart(chartData, `图表: ${input.analysis_type}`)
        }
      }

      const output = chartImg
        ? `${result}\n\n![图表](${chartImg})`
        : result

      return { success: true, output }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  },
})

