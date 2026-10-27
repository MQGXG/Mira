import { describe, expect, test } from 'vitest'
import { extractWidgetBlocks, prepareWidgetHtml, widgetFileName, svgFileName, wrapStandaloneHtml, copyTextToClipboard, normalizeSvgSize } from './widget-utils'

describe('extractWidgetBlocks', () => {
  test('提取单个 widget 代码块并清理文本', () => {
    const text = '下面是一个图表\n\n```html\n<canvas id="c"></canvas>\n```\n\n以上'
    const { cleanText, widgets } = extractWidgetBlocks(text)
    expect(widgets.length).toBe(1)
    expect(widgets[0].html).toContain('<canvas')
    expect(widgets[0].lang).toBe('html')
    expect(cleanText).not.toContain('```html')
    expect(cleanText).toContain('下面是一个图表')
  })

  test('提取多个 widget 代码块', () => {
    const text = '```html\n<svg></svg>\n```\n\n中间文本\n\n```html\n<div>第二</div>\n```'
    const { cleanText, widgets } = extractWidgetBlocks(text)
    expect(widgets.length).toBe(2)
    expect(widgets.every((w) => w.lang === 'html')).toBe(true)
    expect(cleanText).toContain('中间文本')
  })

  test('提取 ```svg 代码块并标记 lang=svg', () => {
    const text = '流程图如下\n\n```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```'
    const { cleanText, widgets } = extractWidgetBlocks(text)
    expect(widgets.length).toBe(1)
    expect(widgets[0].lang).toBe('svg')
    expect(widgets[0].html).toContain('</svg>')
    expect(cleanText).toContain('流程图如下')
  })

  test('未闭合的 ```svg 块不提取（流式安全）', () => {
    const text = '```html\n<div>ok</div>\n```\n\n流式中\n\n```svg\n<svg><rect/>'
    const { cleanText, widgets } = extractWidgetBlocks(text)
    expect(widgets.length).toBe(1)
    expect(widgets[0].lang).toBe('html')
    expect(cleanText).toContain('流式中')
    expect(cleanText).toContain('```svg')
  })

  test('```widget 代码块按 html 处理', () => {
    const text = '```widget\n<div>x</div>\n```'
    const { widgets } = extractWidgetBlocks(text)
    expect(widgets[0].lang).toBe('html')
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

describe('svg 辅助函数（修改点：svg 卡片 + 图片导出）', () => {
  test('svgFileName 提取 <title> 生成 .svg 文件名', () => {
    expect(svgFileName('<svg><title>架构图</title></svg>')).toBe('架构图.svg')
    expect(svgFileName('<svg><rect/></svg>')).toBe('widget.svg')
  })

  test('normalizeSvgSize 补齐仅 viewBox 的尺寸', () => {
    const out = normalizeSvgSize('<svg viewBox="0 0 320 200"></svg>')
    expect(out).toContain('width="320"')
    expect(out).toContain('height="200"')
  })

  test('normalizeSvgSize 已有 width/height 时原样返回', () => {
    const src = '<svg width="10" height="10"></svg>'
    expect(normalizeSvgSize(src)).toBe(src)
  })
})
