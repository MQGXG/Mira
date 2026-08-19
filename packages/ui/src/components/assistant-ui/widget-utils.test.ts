import { describe, expect, test } from 'vitest'
import { extractWidgetBlocks, prepareWidgetHtml, widgetFileName, wrapStandaloneHtml, copyTextToClipboard } from './widget-utils'

describe('extractWidgetBlocks', () => {
  test('提取单个 widget 代码块并清理文本', () => {
    const text = '下面是一个图表\n\n```html\n<canvas id="c"></canvas>\n```\n\n以上'
    const { cleanText, widgets } = extractWidgetBlocks(text)
    expect(widgets.length).toBe(1)
    expect(widgets[0]).toContain('<canvas')
    expect(cleanText).not.toContain('```html')
    expect(cleanText).toContain('下面是一个图表')
  })

  test('提取多个 widget 代码块', () => {
    const text = '```html\n<svg></svg>\n```\n\n中间文本\n\n```html\n<div>第二</div>\n```'
    const { cleanText, widgets } = extractWidgetBlocks(text)
    expect(widgets.length).toBe(2)
    expect(cleanText).toContain('中间文本')
  })

  test('无 widget 时原样返回', () => {
    const text = '普通文本，没有代码块'
    const { cleanText, widgets } = extractWidgetBlocks(text)
    expect(widgets.length).toBe(0)
    expect(cleanText).toBe(text)
  })

  test('空文本返回空', () => {
    const { cleanText, widgets } = extractWidgetBlocks('')
    expect(widgets.length).toBe(0)
    expect(cleanText).toBe('')
  })
})

describe('prepareWidgetHtml', () => {
  const fakeChart = '/* FAKE CHART SOURCE */'
  const libs = { 'chart.js': fakeChart }

  test('替换 CDN chart.js 引用为本地注入', () => {
    const html = '<div><canvas id="c"></canvas></div>\n<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>\n<script>new Chart()</script>'
    const { processed, neededLibs } = prepareWidgetHtml(html, libs)
    expect(processed).not.toContain('cdnjs.cloudflare.com')
    expect(processed).toContain('FAKE CHART SOURCE')
    expect(neededLibs).toContain('chart.js')
    expect(processed).toContain('new Chart()')
  })

  test('移除其他外部 script（安全）', () => {
    const html = '<script src="https://evil.com/x.js"></script>\n<div>内容</div>'
    const { processed } = prepareWidgetHtml(html, libs)
    expect(processed).not.toContain('evil.com')
    expect(processed).toContain('内容')
  })

  test('空 HTML 返回占位', () => {
    const { processed } = prepareWidgetHtml('', libs)
    expect(processed).toContain('空内容')
  })
})

describe('widgetFileName', () => {
  test('提取 <title> 生成文件名', () => {
    expect(widgetFileName('<html><head><title>销售趋势图</title></head><body></body></html>')).toBe('销售趋势图.html')
  })

  test('无 title 时使用 fallback', () => {
    expect(widgetFileName('<div>hi</div>')).toBe('widget.html')
    expect(widgetFileName('<div>hi</div>', 'chart.html')).toBe('chart.html')
  })

  test('非法文件名字符被替换', () => {
    expect(widgetFileName('<title>a/b:c*d</title>')).toBe('a_b_c_d.html')
  })
})

describe('wrapStandaloneHtml', () => {
  test('片段 HTML 包装为完整文档', () => {
    const out = wrapStandaloneHtml('<svg></svg>')
    expect(out).toMatch(/^<!DOCTYPE html>/)
    expect(out).toContain('<svg></svg>')
  })

  test('完整文档原样返回', () => {
    const full = '<html><body><svg></svg></body></html>'
    expect(wrapStandaloneHtml(full)).toBe(full)
  })

  test('空输入返回空', () => {
    expect(wrapStandaloneHtml('')).toBe('')
  })
})

describe('copyTextToClipboard', () => {
  test('无剪贴板/DOM 环境优雅降级（返回 false）', async () => {
    const ok = await copyTextToClipboard('hi')
    expect(ok).toBe(false)
  })
})
