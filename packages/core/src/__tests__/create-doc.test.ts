import { describe, expect, test } from 'vitest'
import { createXlsxTool } from '../tools/core/create-xlsx'
import { createPptxTool } from '../tools/core/create-pptx'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-doc-test-'))
const ctx = { workspace: tmpWorkspace } as any

describe('create_xlsx', () => {
  test('生成多工作表 Excel', async () => {
    const r = await createXlsxTool.execute({
      path: 'report.xlsx',
      sheets: [
        { name: '销售', headers: ['月份', '销售额'], rows: [['一月', 120], ['二月', 150]] },
        { name: '客户', headers: ['客户', '地区'], rows: [['A', '北京']] },
      ],
    }, ctx)
    expect(r.success).toBe(true)
    const file = path.join(tmpWorkspace, 'report.xlsx')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).size).toBeGreaterThan(1000)
  })

  test('路径逃逸被拒绝', async () => {
    const r = await createXlsxTool.execute({
      path: '../evil.xlsx',
      sheets: [{ name: 'S', rows: [['x']] }],
    }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('escape')
  })
})

describe('create_pptx', () => {
  test('生成含封面和表格的 PPT', async () => {
    const r = await createPptxTool.execute({
      path: 'deck.pptx',
      title: '标题',
      slides: [
        { title: '概述', bullets: ['要点1', '要点2'] },
        { title: '数据', table: { headers: ['季度', '营收'], rows: [['Q1', '100'], ['Q2', '125']] } },
      ],
    }, ctx)
    expect(r.success).toBe(true)
    const file = path.join(tmpWorkspace, 'deck.pptx')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).size).toBeGreaterThan(1000)
  })

  test('路径逃逸被拒绝', async () => {
    const r = await createPptxTool.execute({
      path: '../evil.pptx',
      slides: [{ title: 'x' }],
    }, ctx)
    expect(r.success).toBe(false)
  })
})

// 清理测试目录
import { afterAll } from 'vitest'
afterAll(() => {
  try { fs.rmSync(tmpWorkspace, { recursive: true, force: true }) } catch { /* ignore */ }
})
