import { describe, expect, test, afterAll } from 'vitest'
import { createWebpageTool } from '../tools/core/create-webpage'
import { createMockupTool } from '../tools/core/create-mockup'
import { createSvgTool } from '../tools/core/create-svg'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-visual-test-'))
const ctx = { workspace: tmpWs } as any

describe('create_webpage (Interactive)', () => {
  test('生成含 JS 和 CSS 的 HTML 页面', async () => {
    const r = await createWebpageTool.execute({
      path: 'app.html',
      title: '看板',
      body: '<button>点我</button>',
      scripts: 'console.log("hi")',
      styles: 'body { color: red; }',
    }, ctx)
    expect(r.success).toBe(true)
    const file = path.join(tmpWs, 'app.html')
    expect(fs.existsSync(file)).toBe(true)
    const html = fs.readFileSync(file, 'utf-8')
    expect(html).toContain('<script>')
    expect(html).toContain('<style>')
    expect(html).toContain('console.log')
  })

  test('路径逃逸被拒绝', async () => {
    const r = await createWebpageTool.execute({ path: '../evil.html', body: 'x' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('escape')
  })
})

describe('create_mockup (线框图)', () => {
  test('生成含导航栏和卡片的 SVG 线框图', async () => {
    const r = await createMockupTool.execute({
      title: '首页',
      elements: [
        { type: 'navbar', label: '导航', x: 0, y: 0, w: 780, h: 50 },
        { type: 'card', label: '卡片', x: 0, y: 60, w: 200, h: 120 },
      ],
    }, ctx)
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/^<svg/)
    expect(r.output).toContain('导航')
    expect(r.output).toContain('stroke-dasharray')  // navbar 虚线风格
  })
})

describe('create_svg (Art 插画)', () => {
  test('渐变风格含 linearGradient', async () => {
    const r = await createSvgTool.execute({ title: '封面', style: 'gradient', width: 800, height: 500 }, ctx)
    expect(r.success).toBe(true)
    expect(r.output).toMatch(/^<svg/)
    expect(r.output).toContain('linearGradient')
  })

  test('minimal 风格无渐变', async () => {
    const r = await createSvgTool.execute({ title: '简约', style: 'minimal', width: 800, height: 500 }, ctx)
    expect(r.success).toBe(true)
    expect(r.output).not.toContain('linearGradient')
  })
})

afterAll(() => {
  try { fs.rmSync(tmpWs, { recursive: true, force: true }) } catch { /* ignore */ }
})
