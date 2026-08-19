import { describe, expect, test } from 'vitest'
import { inlineSvgBlocks } from '../svg-inline'

/** base64（binary string）还原为 UTF-8 文本 */
function decodeBase64(b64: string): string {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const SIMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#4f46e5"/></svg>`

describe('inlineSvgBlocks', () => {
  test('完整闭合的 ```svg 代码块保留源码并追加内嵌 data URL 渲染图', () => {
    const md = `说明文字\n\n\`\`\`svg\n${SIMPLE_SVG}\n\`\`\`\n\n结尾`
    const out = inlineSvgBlocks(md)
    // 源码代码块保留
    expect(out).toContain('```svg')
    expect(out).toContain(SIMPLE_SVG)
    // 追加渲染图
    const match = out.match(/src="(data:image\/svg\+xml;base64,([^"]+))"/)
    expect(match).not.toBeNull()
    const [, src, b64] = match!
    expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true)
    // base64 内容与原始 SVG 一致
    expect(decodeBase64(b64)).toBe(SIMPLE_SVG)
    expect(out).toContain('说明文字')
    expect(out).toContain('结尾')
  })

  test('svg+xml 语言同样保留源码并追加渲染图', () => {
    const md = `\`\`\`svg+xml\n${SIMPLE_SVG}\n\`\`\``
    const out = inlineSvgBlocks(md)
    expect(out).toContain('```svg+xml')
    expect(out).toContain('data:image/svg+xml;base64,')
  })

  test('未完整闭合的代码块（流式中途）保持源码', () => {
    const partial = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10"`
    const md = `\`\`\`svg\n${partial}\n\`\`\``
    const out = inlineSvgBlocks(md)
    expect(out).toBe(md)
    expect(out).not.toContain('data:image')
  })

  test('非 svg 代码块不受影响', () => {
    const md = `\`\`\`ts\nconst x: number = 1\n\`\`\``
    expect(inlineSvgBlocks(md)).toBe(md)
  })

  test('普通文本（无代码块）原样返回', () => {
    const md = '你好，这是一段普通文本。'
    expect(inlineSvgBlocks(md)).toBe(md)
  })

  test('多个 svg 块：全部保留源码并各追加渲染图', () => {
    const svg2 = `<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>`
    const md = `\`\`\`svg\n${SIMPLE_SVG}\n\`\`\`\n\n\`\`\`svg\n${svg2}\n\`\`\``
    const out = inlineSvgBlocks(md)
    const matches = out.match(/data:image\/svg\+xml;base64,/g)
    expect(matches).toHaveLength(2)
    // 两个源码块均保留
    expect(out.match(/```svg/g)).toHaveLength(2)
  })

  test('含中文内容的 SVG 正确编码（UTF-8 安全）', () => {
    const zhSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="30" font-size="20">架构图</text></svg>`
    const md = `\`\`\`svg\n${zhSvg}\n\`\`\``
    const out = inlineSvgBlocks(md)
    const match = out.match(/base64,([^"]+)/)
    expect(match).not.toBeNull()
    expect(decodeBase64(match![1])).toBe(zhSvg)
  })
})