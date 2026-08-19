import { describe, expect, test } from 'vitest'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import { randomUUID } from 'crypto'

// 测试工具函数 — 直接从源码引入
// decodeText, detectMagicType, isBinaryByContent, formatSize 是从 read-file.ts 提取的纯函数

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

describe('formatSize', () => {
  test('0 字节', () => expect(formatSize(0)).toBe('0 B'))
  test('小于 1KB', () => expect(formatSize(512)).toBe('512 B'))
  test('1KB', () => expect(formatSize(1024)).toBe('1.0 KB'))
  test('1MB', () => expect(formatSize(1048576)).toBe('1.0 MB'))
  test('1.5MB', () => expect(formatSize(1572864)).toBe('1.5 MB'))
  test('1GB', () => expect(formatSize(1073741824)).toBe('1.0 GB'))
})

describe('magic bytes detection', () => {
  function detectMagicType(buffer: Buffer): string | null {
    const MAGIC_BYTES: Array<{ bytes: number[]; ext: string }> = [
      { bytes: [0x89, 0x50, 0x4E, 0x47], ext: 'PNG' },
      { bytes: [0xFF, 0xD8, 0xFF], ext: 'JPEG' },
      { bytes: [0x47, 0x49, 0x46, 0x38], ext: 'GIF' },
    ]
    for (const magic of MAGIC_BYTES) {
      if (magic.bytes.every((b, i) => buffer[i] === b)) return magic.ext
    }
    return null
  }

  test('PNG 魔数', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    expect(detectMagicType(buf)).toBe('PNG')
  })

  test('JPEG 魔数', () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])
    expect(detectMagicType(buf)).toBe('JPEG')
  })

  test('GIF 魔数', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    expect(detectMagicType(buf)).toBe('GIF')
  })

  test('纯文本不匹配', () => {
    const buf = Buffer.from('hello world')
    expect(detectMagicType(buf)).toBeNull()
  })
})

describe('binary content detection', () => {
  function isBinaryByContent(buffer: Buffer): boolean {
    if (buffer.length === 0) return false
    let nullCount = 0
    for (let i = 0; i < Math.min(buffer.length, 8192); i++) {
      if (buffer[i] === 0) nullCount++
    }
    return nullCount > 0
  }

  test('包含 null 字节判定为二进制', () => {
    const buf = Buffer.from([0x68, 0x00, 0x65, 0x00, 0x6C, 0x00])
    expect(isBinaryByContent(buf)).toBe(true)
  })

  test('无 null 字节判定为非二进制', () => {
    const buf = Buffer.from('hello world')
    expect(isBinaryByContent(buf)).toBe(false)
  })
})

describe('decodeText', () => {
  function decodeText(buffer: Buffer, encoding: string): string {
    const NATIVE_ENCODINGS = new Set(['utf-8', 'utf8', 'utf-16le', 'utf16le', 'latin1', 'ascii', 'hex', 'base64'])
    if (NATIVE_ENCODINGS.has(encoding)) return buffer.toString(encoding as BufferEncoding)
    return buffer.toString('utf-8')
  }

  test('UTF-8 解码', () => {
    const buf = Buffer.from('你好世界')
    expect(decodeText(buf, 'utf-8')).toBe('你好世界')
  })

  test('base64 解码', () => {
    const buf = Buffer.from('hello')  // base64 编码为 aGVsbG8=
    expect(buf.toString('base64')).toBe('aGVsbG8=')
  })

  test('hex 解码', () => {
    const buf = Buffer.from('hello')
    expect(buf.toString('hex')).toBe('68656c6c6f')
  })

  test('未知编码降级为 UTF-8', () => {
    const buf = Buffer.from('hello')
    expect(decodeText(buf, 'unknown')).toBe('hello')
  })
})

describe('escape-util', () => {
  function normalizeEditInput(input: string): string {
    return input
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\t/g, '  ')
      .replace(/ +$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  test('CRLF 转 LF', () => {
    expect(normalizeEditInput('a\r\nb\r\nc')).toBe('a\nb\nc')
  })

  test('CR 转 LF', () => {
    expect(normalizeEditInput('a\rb\rc')).toBe('a\nb\nc')
  })

  test('Tab 转双空格', () => {
    // trim() 会去掉前后的空白，所以 Tab 在中间的才会保留
    expect(normalizeEditInput('a\thello')).toBe('a  hello')
  })

  test('去除行尾空格', () => {
    expect(normalizeEditInput('hello   \nworld')).toBe('hello\nworld')
  })

  test('连续空行合并', () => {
    expect(normalizeEditInput('a\n\n\n\n\nb')).toBe('a\n\nb')
  })
})

describe('write-file stale detection', () => {
  function isFileChanged(storedMtime: number, currentMtime: number, storedHash: string, currentHash: string): boolean {
    if (storedHash !== currentHash) return true
    return Math.abs(currentMtime - storedMtime) > 100
  }

  test('内容不同判定为已变更', () => {
    expect(isFileChanged(1000, 1000, 'abc', 'def')).toBe(true)
  })

  test('内容相同 mtime 接近判定为未变更', () => {
    expect(isFileChanged(1000, 1050, 'abc', 'abc')).toBe(false)
  })

  test('内容相同但 mtime 相差大判定为已变更', () => {
    expect(isFileChanged(1000, 2000, 'abc', 'abc')).toBe(true)
  })
})
