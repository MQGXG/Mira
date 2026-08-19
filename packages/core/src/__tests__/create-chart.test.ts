import { describe, expect, test } from 'vitest'
import { createChartTool } from '../tools/knowledge/create-chart'

const emptyCtx = {} as any

describe('create_chart 数据图表', () => {
  test('生成柱状图 SVG', async () => {
    const r = await createChartTool.execute({
      mode: 'data', chart_type: 'bar', title: '销售',
      data: [{ label: '一月', value: 120 }, { label: '二月', value: 200 }],
    }, emptyCtx)
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/^<svg/)
    expect(r.output).toContain('rect')
    expect(r.output).toContain('销售')
  })

  test('生成饼图 SVG（含百分比）', async () => {
    const r = await createChartTool.execute({
      mode: 'data', chart_type: 'pie', title: '份额',
      data: [{ label: 'A', value: 40 }, { label: 'B', value: 30 }],
    }, emptyCtx)
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/^<svg/)
    expect(r.output).toContain('path')
  })

  test('空数据返回错误', async () => {
    const r = await createChartTool.execute({ mode: 'data', data: [] }, emptyCtx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('data')
  })

  test('非法数据被过滤', async () => {
    const r = await createChartTool.execute({
      mode: 'data',
      data: [{ label: 'ok', value: 1 }, { label: 'bad', value: NaN }],
    }, emptyCtx)
    expect(r.success).toBe(true)
  })
})

describe('create_chart 流程图', () => {
  test('definition 含方向缩写时补 flowchart 头', async () => {
    const r = await createChartTool.execute({
      mode: 'flowchart', diagram_type: 'flowchart', title: '登录',
      definition: 'TD\nA[开始] --> B[结束]',
    }, emptyCtx)
    expect(r.success).toBe(true)
    expect(r.output).toContain('```mermaid')
    expect(r.output).toContain('flowchart TD')
    expect(r.output).not.toContain('flowchart\nTD')  // 方向并入同一行
  })

  test('definition 含完整头时原样使用', async () => {
    const r = await createChartTool.execute({
      mode: 'flowchart', diagram_type: 'flowchart', title: '流程',
      definition: 'graph LR\nA --> B',
    }, emptyCtx)
    expect(r.success).toBe(true)
    expect(r.output).toContain('graph LR')
    expect(r.output).not.toContain('flowchart\ngraph')
  })

  test('时序图', async () => {
    const r = await createChartTool.execute({
      mode: 'flowchart', chart_type: 'bar', diagram_type: 'sequenceDiagram', title: '时序',
      definition: 'A->>B: 请求\nB-->>A: 响应',
    }, emptyCtx)
    expect(r.success).toBe(true)
    expect(r.output).toContain('sequenceDiagram')
  })
})
